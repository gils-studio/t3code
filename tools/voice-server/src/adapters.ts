import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";

import type { Config } from "./config.ts";
import type { Job, JobStore } from "./jobStore.ts";
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
    const child = spawn(command, args, {
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

/** whisper.cpp runs per job and exits, so nothing stays in RAM or VRAM between dictations. */
export class WhisperTranscriber implements Transcriber {
  private readonly config: Config;
  private readonly store: JobStore;

  constructor(config: Config, store: JobStore) {
    this.config = config;
    this.store = store;
  }

  async transcribe(job: Job): Promise<string> {
    const wav = this.store.workPath(job.id, "audio.wav");
    const outputBase = this.store.workPath(job.id, "transcript");
    try {
      await run(
        this.config.ffmpeg,
        [
          "-y",
          "-loglevel",
          "error",
          "-i",
          this.store.audioPath(job.id),
          "-ar",
          "16000",
          "-ac",
          "1",
          wav,
        ],
        { timeoutMillis: 120_000 },
      );
      const { size } = await fs.stat(wav);
      const audioSeconds = size / 32_000;
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
          ...(this.config.prompt ? ["--prompt", this.config.prompt] : []),
        ],
        // Generous: a slow run is fine, only a hung process must not block the queue forever.
        { timeoutMillis: Math.max(120_000, audioSeconds * 3_000), cwd: this.config.whisperCwd },
      );
      const text = await fs.readFile(`${outputBase}.txt`, "utf8");
      return text.replace(/\s*\n\s*/g, " ").trim();
    } finally {
      await fs.rm(wav, { force: true });
      await fs.rm(`${outputBase}.txt`, { force: true });
    }
  }
}

const THREAD_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Uses T3's own CLI, so a busy thread gets the message as its next turn. */
export class T3CliSender implements ThreadSender {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async send(threadId: string, text: string): Promise<void> {
    this.assertThreadId(threadId);
    await run(this.config.t3Command, ["thread", "send", threadId, "-"], {
      stdin: text,
      timeoutMillis: 120_000,
      shell: true,
    });
  }

  async hasMessage(threadId: string, text: string): Promise<boolean> {
    this.assertThreadId(threadId);
    const { stdout } = await run(this.config.t3Command, ["thread", "show", threadId, "--json", "--messages", "50"], {
      timeoutMillis: 60_000,
      shell: true,
    });
    return stdout.includes(JSON.stringify(text).slice(1, -1));
  }

  private assertThreadId(threadId: string): void {
    if (!THREAD_ID_PATTERN.test(threadId)) throw new Error("Invalid thread id.");
  }
}
