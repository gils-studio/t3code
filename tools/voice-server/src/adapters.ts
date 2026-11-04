import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { Config } from "./config.ts";
import type { Job, JobStore } from "./jobStore.ts";
import { correctTranscript, readVocabulary } from "./vocabulary.ts";
import type { WhisperServer } from "./whisperServer.ts";
import type { ThreadSender, Transcriber } from "./worker.ts";

type RunOptions = {
  readonly timeoutMillis: number;
  readonly stdin?: string;
  readonly cwd?: string;
  readonly shell?: boolean;
};

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions,
): Promise<{ readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMillis);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout });
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-400)}`));
    });
    child.stdin.end(options.stdin ?? "");
  });
}

const SPEECH_SEGMENTS = /Detected ([0-9]+) speech segments/;

/** Anything but a clear zero counts as speech: a stray transcript beats lost words. */
export const foundNoSpeech = (vadOutput: string): boolean =>
  SPEECH_SEGMENTS.exec(vadOutput)?.[1] === "0";

/** Skipping after the input lets ffmpeg count samples; raw ADTS has no index to seek by. */
export const decodeToWav = (
  config: Config,
  audio: string,
  wav: string,
  startSeconds = 0,
): Promise<unknown> =>
  run(
    config.ffmpeg,
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      audio,
      "-ss",
      String(startSeconds),
      "-ar",
      "16000",
      "-ac",
      "1",
      wav,
    ],
    { timeoutMillis: 120_000 },
  );

/**
 * Whisper invents subtitle credits for silence. VAD only gates the run, because
 * whisper's own --vad drops words next to its cut points.
 */
export async function isSilent(config: Config, wav: string): Promise<boolean> {
  if (!config.vadModel) return false;
  const tool = NodePath.join(
    NodePath.dirname(config.whisperCli),
    "whisper-vad-speech-segments.exe",
  );
  const { stdout } = await run(tool, ["-vm", config.vadModel, "-f", wav, "--no-prints"], {
    timeoutMillis: 60_000,
    cwd: config.whisperCwd,
  }).catch(() => ({ stdout: "" }));
  return foundNoSpeech(stdout);
}

/** Lines are whisper segments: they keep their own leading space and can split a word. */
const singleLine = (text: string) =>
  text
    .split(/[\r\n]+/)
    .join("")
    .trim();

/** Prefers the warm server; the per-job CLI stays as the path that needs nothing running. */
/** Timers reject a fractional delay, and audio length rarely is a whole number. */
export const transcriptionTimeoutMillis = (audioSeconds: number) =>
  Math.max(120_000, Math.ceil(audioSeconds * 3_000));

export class WhisperTranscriber implements Transcriber {
  private readonly config: Config;
  private readonly store: JobStore;
  private readonly server: WhisperServer;
  private readonly log: (message: string) => void;

  constructor(
    config: Config,
    store: JobStore,
    server: WhisperServer,
    log: (message: string) => void,
  ) {
    this.config = config;
    this.store = store;
    this.server = server;
    this.log = log;
  }

  private async runCli(job: Job, wav: string, timeoutMillis: number): Promise<string> {
    const outputBase = this.store.workPath(job.id, "transcript");
    const { prompt } = readVocabulary();
    try {
      await run(
        this.config.whisperCli,
        [
          "-m",
          this.config.model,
          "-f",
          wav,
          "-l",
          job.language,
          "-nt",
          "-otxt",
          "-of",
          outputBase,
          ...this.config.whisperArgs,
          ...(prompt ? ["--prompt", prompt] : []),
        ],
        { timeoutMillis, cwd: this.config.whisperCwd },
      );
      return await NodeFSP.readFile(`${outputBase}.txt`, "utf8");
    } finally {
      await NodeFSP.rm(`${outputBase}.txt`, { force: true });
    }
  }

  async transcribe(job: Job): Promise<string> {
    const wav = this.store.workPath(job.id, "audio.wav");
    try {
      await decodeToWav(this.config, this.store.audioPath(job.id), wav);
      const { size } = await NodeFSP.stat(wav);
      const audioSeconds = size / 32_000;
      // Generous: a slow run is fine, only a hung process must not block the queue forever.
      const timeoutMillis = transcriptionTimeoutMillis(audioSeconds);
      const startedAt = Date.now();
      const [silent, text] = await Promise.all([
        isSilent(this.config, wav),
        this.server.recognize(wav, job.language, { timeoutMillis }).then(
          (result) => result.text,
          (error: unknown) => {
            this.log(`whisper-server failed, using the CLI: ${String(error)}`);
            return this.runCli(job, wav, timeoutMillis);
          },
        ),
      ]);
      this.log(
        `transcribed ${Math.round(audioSeconds)} s of audio in ${Date.now() - startedAt} ms`,
      );
      return silent ? "" : correctTranscript(singleLine(text));
    } finally {
      await NodeFSP.rm(wav, { force: true });
    }
  }
}

const THREAD_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/**
 * The CLI files messages under "agent"; clients show this prefix as the user's own words and hide
 * the name, which is there for the agent. The same text as in packages/client-runtime.
 */
export const voiceMessagePrefix = (speaker?: string) =>
  speaker ? `[Voice message from ${speaker}]\n\n` : "[Voice message]\n\n";

/** Uses T3's own CLI, so a busy thread gets the message as its next turn. */
export class T3CliSender implements ThreadSender {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async send(threadId: string, text: string, speaker?: string): Promise<void> {
    this.assertThreadId(threadId);
    await run(this.config.t3Command, ["thread", "send", threadId, "-"], {
      stdin: `${voiceMessagePrefix(speaker)}${text}`,
      timeoutMillis: 120_000,
      shell: true,
    });
  }

  async hasMessage(threadId: string, text: string): Promise<boolean> {
    this.assertThreadId(threadId);
    const { stdout } = await run(
      this.config.t3Command,
      ["thread", "show", threadId, "--json", "--messages", "50"],
      {
        timeoutMillis: 60_000,
        shell: true,
      },
    );
    return stdout.includes(JSON.stringify(text).slice(1, -1));
  }

  private assertThreadId(threadId: string): void {
    if (!THREAD_ID_PATTERN.test(threadId)) throw new Error("Invalid thread id.");
  }
}
