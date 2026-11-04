import type { Job, JobStore } from "./jobStore.ts";

export interface Transcriber {
  transcribe(job: Job): Promise<string>;
}

export interface ThreadSender {
  send(threadId: string, text: string): Promise<void>;
  /** Used after a crash during send: at-least-once, without a visible duplicate. */
  hasMessage(threadId: string, text: string): Promise<boolean>;
}

export type WorkerOptions = {
  readonly store: JobStore;
  readonly transcriber: Transcriber;
  readonly sender: ThreadSender;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly retentionMillis?: number;
  readonly idleWaitMillis?: number;
};

const MAX_TRANSCRIPTION_ATTEMPTS = 6;
const BASE_RETRY_MILLIS = 5_000;
const MAX_RETRY_MILLIS = 5 * 60_000;
const DEFAULT_RETENTION_MILLIS = 14 * 24 * 60 * 60_000;

export const retryDelayMillis = (attempts: number): number =>
  Math.min(MAX_RETRY_MILLIS, BASE_RETRY_MILLIS * 2 ** Math.max(0, attempts - 1));

/** Whisper labels silence and noise, as in "* Musik *"; only a text of nothing else is empty. */
const ONLY_NOISE_MARKERS = /^(?:\s*(?:\*[^*]*\*|\[[^\]]*\]|\([^)]*\)))+\s*$/;

export function withoutNoiseMarkers(transcript: string): string {
  return ONLY_NOISE_MARKERS.test(transcript) ? "" : transcript.trim();
}

export const composeMessage = (prefixText: string, transcript: string): string =>
  [prefixText.trim(), transcript.trim()].filter((part) => part.length > 0).join("\n\n");

/**
 * Runs one job at a time, so concurrent speakers wait in the queue and the GPU
 * and RAM cost never grows with the number of recordings.
 */
export class Worker {
  private readonly options: WorkerOptions;
  private readonly now: () => number;
  private wake: (() => void) | null = null;
  private stopped = false;
  private running: Promise<void> | null = null;

  constructor(options: WorkerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** An interrupted transcription simply runs again; its audio is still on disk. */
  async recover(): Promise<void> {
    for (const job of this.options.store.all()) {
      if (job.status === "transcribing") {
        await this.options.store.update(job.id, { status: "queued" }, this.now());
      }
    }
  }

  start(): void {
    this.running ??= this.loop();
  }

  notify(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.notify();
    await this.running;
  }

  /** Runs the next due job; false when nothing is due. */
  async runNext(): Promise<boolean> {
    const job = this.nextDueJob();
    if (!job) return false;
    await this.process(job);
    return true;
  }

  async purgeExpired(): Promise<void> {
    const retention = this.options.retentionMillis ?? DEFAULT_RETENTION_MILLIS;
    for (const job of this.options.store.all()) {
      if (job.status === "done" && this.now() - job.updatedAt > retention) {
        await this.options.store.remove(job.id);
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.purgeExpired();
        if (await this.runNext()) continue;
      } catch (error) {
        this.options.log?.(`worker error: ${String(error)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.idleWaitMillis ?? 2_000);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  private nextDueJob(): Job | undefined {
    return this.options.store
      .all()
      .filter(
        (job) =>
          (job.status === "queued" || job.status === "sending") && job.nextAttemptAt <= this.now(),
      )
      .toSorted((left, right) => left.createdAt - right.createdAt)[0];
  }

  private async process(job: Job): Promise<void> {
    if (job.status === "sending") {
      await this.send(job);
      return;
    }
    const { store } = this.options;
    const started = await store.update(job.id, { status: "transcribing" }, this.now());
    let transcript: string;
    try {
      transcript = withoutNoiseMarkers(await this.options.transcriber.transcribe(started));
    } catch (error) {
      const attempts = started.attempts + 1;
      this.options.log?.(`transcription failed for ${job.id}: ${String(error)}`);
      await store.update(
        job.id,
        {
          status: attempts >= MAX_TRANSCRIPTION_ATTEMPTS ? "failed" : "queued",
          attempts,
          lastError: String(error),
          nextAttemptAt: this.now() + retryDelayMillis(attempts),
        },
        this.now(),
      );
      return;
    }
    // One write, so a claim lands either before this decision or is refused after it.
    const transcribed = await store.update(
      job.id,
      ({ mode }) => ({
        transcript,
        attempts: 0,
        lastError: null,
        // Nothing was said: a voice message without words must not reach the agent.
        status: mode === "draft" || transcript.length === 0 ? "done" : "sending",
      }),
      this.now(),
    );
    if (transcribed.status === "sending") await this.send(transcribed);
  }

  /** The T3 server may be down or restarting, so sending retries for as long as it takes. */
  private async send(job: Job): Promise<void> {
    const { store, sender } = this.options;
    const message = composeMessage(job.prefixText, job.transcript ?? "");
    try {
      if (job.sendStarted && (await sender.hasMessage(job.threadId, message))) {
        await store.update(job.id, { status: "done" }, this.now());
        return;
      }
      await store.update(job.id, { sendStarted: true }, this.now());
      await sender.send(job.threadId, message);
      await store.update(job.id, { status: "done", lastError: null }, this.now());
    } catch (error) {
      const attempts = job.attempts + 1;
      this.options.log?.(`send failed for ${job.id}: ${String(error)}`);
      await store.update(
        job.id,
        {
          attempts,
          lastError: String(error),
          nextAttemptAt: this.now() + retryDelayMillis(attempts),
        },
        this.now(),
      );
    }
  }
}
