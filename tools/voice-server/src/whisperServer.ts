import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import type { Config } from "./config.ts";

export type SpeechSegment = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

export type Recognition = {
  readonly text: string;
  readonly segments: ReadonlyArray<SpeechSegment>;
};

const DEFAULT_PORT = 4792;
const DEFAULT_IDLE_SECONDS = 120;
const READY_TIMEOUT_MILLIS = 60_000;
const READY_POLL_MILLIS = 100;
const WAV_BYTES_PER_SECOND = 32_000;
const ENCODER_FRAMES_PER_SECOND = 50;
const ENCODER_MAX_FRAMES = 1_500;
const ENCODER_SPARE_FRAMES = 64;

/** A hard-killed service leaves its children behind, still holding their port or subdomain. */
export async function closeLeftoverProcess(pidFile: string, executable: string): Promise<void> {
  const pid = Number(await NodeFSP.readFile(pidFile, "utf8").catch(() => ""));
  if (!pid) return;
  const processes = NodeChildProcess.execFileSync("tasklist", ["/FI", `PID eq ${pid}`], {
    encoding: "utf8",
  });
  if (processes.toLowerCase().includes(executable)) process.kill(pid);
}

/**
 * Keeps the model loaded only around dictation: it starts when a recording does
 * and exits after a short idle time, so an idle PC holds no RAM or VRAM for it.
 */
export class WhisperServer {
  private readonly config: Config;
  private readonly pidFile: string;
  private readonly log: (message: string) => void;
  private child: NodeChildProcess.ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;

  constructor(config: Config, pidFile: string, log: (message: string) => void) {
    this.config = config;
    this.pidFile = pidFile;
    this.log = log;
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.config.whisperServerPort ?? DEFAULT_PORT}`;
  }

  warm(): Promise<void> {
    this.keepAlive();
    this.ready ??= this.start().catch((error: unknown) => {
      this.stop();
      throw error;
    });
    return this.ready;
  }

  /** A preview trades accuracy for speed: greedy, and an encoder sized to the audio, not 30 s. */
  async recognize(
    wav: string,
    language: string,
    options: { readonly timeoutMillis: number; readonly preview?: boolean },
  ): Promise<Recognition> {
    await this.warm();
    this.inFlight += 1;
    try {
      const audio = await NodeFSP.readFile(wav);
      const form = new FormData();
      form.set("file", new Blob([audio]), "audio.wav");
      if (options.preview) {
        const frames = (audio.length / WAV_BYTES_PER_SECOND) * ENCODER_FRAMES_PER_SECOND;
        form.set("beam_size", "1");
        form.set(
          "audio_ctx",
          String(Math.min(ENCODER_MAX_FRAMES, Math.ceil(frames) + ENCODER_SPARE_FRAMES)),
        );
      }
      form.set("response_format", "verbose_json");
      form.set("language", language);
      if (this.config.prompt) form.set("prompt", this.config.prompt);
      const response = await fetch(`${this.baseUrl}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(options.timeoutMillis),
      });
      if (!response.ok) throw new Error(`whisper-server answered with ${response.status}`);
      const result = (await response.json()) as Partial<Recognition> & { error?: string };
      if (result.error) throw new Error(`whisper-server: ${result.error}`);
      const segments = result.segments ?? [];
      // Its text field puts a newline between segments, and segments can end inside a word.
      return { text: segments.map((segment) => segment.text).join(""), segments };
    } finally {
      this.inFlight -= 1;
      this.keepAlive();
    }
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  private keepAlive(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => {
        if (this.inFlight > 0) {
          this.keepAlive();
          return;
        }
        this.log("whisper-server idle, unloading the model");
        this.stop();
      },
      (this.config.whisperIdleSeconds ?? DEFAULT_IDLE_SECONDS) * 1_000,
    );
    this.idleTimer.unref();
  }

  private async start(): Promise<void> {
    const startedAt = Date.now();
    const child = NodeChildProcess.spawn(
      NodePath.join(NodePath.dirname(this.config.whisperCli), "whisper-server.exe"),
      [
        "-m",
        this.config.model,
        "--host",
        "127.0.0.1",
        "--port",
        String(this.config.whisperServerPort ?? DEFAULT_PORT),
        ...this.config.whisperArgs,
      ],
      { cwd: this.config.whisperCwd, stdio: "ignore", windowsHide: true },
    );
    this.child = child;
    let exit: Error | null = null;
    child.on("error", (error) => (exit = error));
    child.on("close", (code) => {
      exit ??= new Error(`whisper-server exited with ${code}`);
      if (this.child === child) this.stop();
    });
    if (child.pid) await NodeFSP.writeFile(this.pidFile, String(child.pid));
    while (Date.now() - startedAt < READY_TIMEOUT_MILLIS) {
      if (exit) throw exit;
      const answered = await fetch(this.baseUrl).then(
        () => true,
        () => false,
      );
      if (answered) {
        this.log(`whisper-server ready after ${Date.now() - startedAt} ms`);
        return;
      }
      await NodeTimersPromises.setTimeout(READY_POLL_MILLIS);
    }
    throw new Error("whisper-server did not start in time");
  }
}
