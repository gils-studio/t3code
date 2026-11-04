import type {
  VoiceRecordingDisposition,
  VoiceRecordingHandoff,
} from "@t3tools/client-runtime/voice-input";

export const VOICE_SERVER_RECORDING_LIMIT_SECONDS = 30 * 60;
const POLL_INTERVAL_MS = 1_000;

export type VoiceJob = {
  readonly status: "queued" | "transcribing" | "sending" | "done" | "failed";
  readonly transcript: string | null;
  readonly queuePosition: number | null;
  readonly lastError: string | null;
};

export type VoiceOutboxPhase = "recording" | "uploading" | "processing" | "no-speech" | "failed";

export type VoiceOutboxItem = {
  readonly id: string;
  readonly ownerKey: string;
  readonly threadId: string | null;
  readonly mode: VoiceRecordingDisposition;
  /** Without a thread the service cannot send, so an open composer sends the finished draft. */
  readonly submitDraft: boolean;
  readonly prefixText: string;
  readonly language: string;
  /** Set until the audio has moved into outbox storage. */
  readonly sourceUri: string | null;
  readonly phase: VoiceOutboxPhase;
  readonly remoteStatus: VoiceJob["status"] | null;
  readonly queuePosition: number | null;
  readonly error: string | null;
  readonly createdAt: number;
};

export type VoiceOutboxStore = {
  list(): Promise<ReadonlyArray<VoiceOutboxItem>>;
  save(item: VoiceOutboxItem): Promise<void>;
  remove(id: string): Promise<void>;
  /** Moves the recording out of the evictable cache; false when no audio exists. */
  adoptAudio(item: VoiceOutboxItem): Promise<boolean>;
};

export type VoiceServerClient = {
  /** Idempotent: an upload already scheduled for this id is left alone. */
  enqueueUpload(item: VoiceOutboxItem): void;
  /** Null until the server has the audio. */
  fetchJob(id: string): Promise<VoiceJob | null>;
  acknowledge(id: string): Promise<void>;
  retry(id: string): Promise<void>;
};

export type VoiceOutboxDependencies = {
  readonly store: VoiceOutboxStore;
  readonly getClient: () => VoiceServerClient | null;
  /** Must resolve only once the text is durably part of the draft. */
  readonly appendDraft: (ownerKey: string, text: string) => Promise<void>;
  /** Without a composer listening the text simply stays in the draft. */
  readonly submitDraft: (ownerKey: string) => void;
  /** Shows the words while they are spoken; the recording never depends on it. */
  readonly live: {
    start(id: string, uri: string, language: string): void;
    stop(): void;
  };
  readonly newId: () => string;
  readonly language: () => string;
  readonly now: () => number;
};

export type VoiceHandoffTarget = {
  readonly ownerKey: string;
  /** Null for a draft without a thread yet; such recordings can only return to the draft. */
  readonly threadId: string | null;
  readonly readDraftText: () => string;
  readonly clearDraftText: () => void;
};

const isInFlight = (item: VoiceOutboxItem) =>
  item.phase === "uploading" || item.phase === "processing";

/**
 * Owns every recording from the first byte until its text has arrived. Items
 * are persisted before anything else happens to them, and an item leaves the
 * outbox only once its text is safe, so a killed app resumes where it stopped.
 */
export class VoiceOutbox {
  private readonly dependencies: VoiceOutboxDependencies;
  private readonly items = new Map<string, VoiceOutboxItem>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyArray<VoiceOutboxItem> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private foreground = false;

  constructor(dependencies: VoiceOutboxDependencies) {
    this.dependencies = dependencies;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.snapshot;

  /** Recordings cut off by a crash are as valuable as finished ones: they become draft text. */
  recover(): Promise<void> {
    return this.enqueue(async () => {
      for (const item of await this.dependencies.store.list()) this.items.set(item.id, item);
      this.publish();
      for (const item of this.items.values()) {
        if (item.phase === "recording") await this.deliver({ ...item, mode: "draft" });
      }
      this.resumeUploads();
    });
  }

  /** Scheduled uploads survive on their own; this covers a client that appeared later. */
  resumeUploads(): void {
    const client = this.dependencies.getClient();
    if (!client) return;
    for (const item of this.items.values()) {
      if (item.phase === "uploading") client.enqueueUpload(item);
    }
    this.schedulePoll();
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground;
    if (foreground) this.resumeUploads();
    else this.cancelPoll();
  }

  createHandoff(target: VoiceHandoffTarget): VoiceRecordingHandoff {
    let id: string | null = null;
    const begin = (uri: string) => {
      const itemId = this.dependencies.newId();
      id = itemId;
      return this.persist({
        id: itemId,
        ownerKey: target.ownerKey,
        threadId: target.threadId,
        mode: "draft",
        submitDraft: false,
        prefixText: "",
        language: this.dependencies.language(),
        sourceUri: uri,
        phase: "recording",
        remoteStatus: null,
        queuePosition: null,
        error: null,
        createdAt: this.dependencies.now(),
      });
    };
    return {
      recordingLimitSeconds: VOICE_SERVER_RECORDING_LIMIT_SECONDS,
      recordingStarted: (uri) =>
        void this.enqueue(async () => {
          await begin(uri);
          this.dependencies.live.start(id!, uri, this.dependencies.language());
        }),
      recordingFinished: (uri, disposition) => {
        const mode = target.threadId === null ? "draft" : disposition;
        const prefixText = mode === "send" ? target.readDraftText() : "";
        void this.enqueue(async () => {
          this.dependencies.live.stop();
          if (id === null) await begin(uri);
          const item = this.items.get(id!);
          if (!item) return;
          const submitDraft = disposition === "send" && mode === "draft";
          const finished = { ...item, mode, submitDraft, prefixText, sourceUri: uri };
          // The typed text may only leave the draft once it is stored with the recording.
          await this.persist(finished);
          if (mode === "send") target.clearDraftText();
          await this.deliver(finished);
        });
      },
      recordingDiscarded: () => {
        void this.enqueue(async () => {
          this.dependencies.live.stop();
          if (id !== null) await this.forget(id);
        });
      },
    };
  }

  retry(id: string): Promise<void> {
    return this.enqueue(async () => {
      const item = this.items.get(id);
      if (!item || item.phase !== "failed") return;
      if (item.sourceUri !== null) {
        await this.deliver(item);
        return;
      }
      await this.dependencies.getClient()?.retry(id);
      await this.persist({ ...item, phase: "processing", error: null });
      this.schedulePoll();
    });
  }

  dismiss(id: string): Promise<void> {
    return this.enqueue(async () => {
      const item = this.items.get(id);
      if (!item || isInFlight(item) || item.phase === "recording") return;
      if (item.prefixText) await this.dependencies.appendDraft(item.ownerKey, item.prefixText);
      await this.dependencies
        .getClient()
        ?.acknowledge(id)
        .catch(() => {});
      await this.forget(id);
    });
  }

  poll(): Promise<void> {
    return this.enqueue(async () => {
      const client = this.dependencies.getClient();
      if (!client) return;
      for (const item of [...this.items.values()].filter(isInFlight)) {
        try {
          await this.pollItem(client, item);
        } catch {
          // Offline or a busy draft store: the next poll tries the same item again.
        }
      }
    });
  }

  private async pollItem(client: VoiceServerClient, item: VoiceOutboxItem): Promise<void> {
    const job = await client.fetchJob(item.id);
    if (!job) {
      client.enqueueUpload(item);
      if (item.phase !== "uploading") await this.persist({ ...item, phase: "uploading" });
      return;
    }
    if (job.status === "failed") {
      await this.persist({
        ...item,
        phase: "failed",
        remoteStatus: job.status,
        error: job.lastError,
      });
      return;
    }
    if (job.status !== "done") {
      if (
        item.phase === "processing" &&
        item.remoteStatus === job.status &&
        item.queuePosition === job.queuePosition
      ) {
        return;
      }
      await this.persist({
        ...item,
        phase: "processing",
        remoteStatus: job.status,
        queuePosition: job.queuePosition,
      });
      return;
    }

    const transcript = job.transcript?.trim() ?? "";
    if (!transcript) {
      if (item.prefixText) await this.dependencies.appendDraft(item.ownerKey, item.prefixText);
      await this.persist({ ...item, prefixText: "", phase: "no-speech", remoteStatus: job.status });
      return;
    }
    if (item.mode === "draft") await this.dependencies.appendDraft(item.ownerKey, transcript);
    await client.acknowledge(item.id);
    await this.forget(item.id);
    if (item.submitDraft) this.dependencies.submitDraft(item.ownerKey);
  }

  private async deliver(item: VoiceOutboxItem): Promise<void> {
    if (!(await this.dependencies.store.adoptAudio(item))) {
      await this.persist({
        ...item,
        phase: "failed",
        error: "The recording could not be saved.",
      });
      return;
    }
    const uploading: VoiceOutboxItem = {
      ...item,
      sourceUri: null,
      phase: "uploading",
      error: null,
    };
    await this.persist(uploading);
    this.dependencies.getClient()?.enqueueUpload(uploading);
    this.schedulePoll();
  }

  private async persist(item: VoiceOutboxItem): Promise<void> {
    await this.dependencies.store.save(item);
    this.items.set(item.id, item);
    this.publish();
  }

  private async forget(id: string): Promise<void> {
    await this.dependencies.store.remove(id);
    this.items.delete(id);
    this.publish();
  }

  private publish(): void {
    this.snapshot = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const listener of this.listeners) listener();
  }

  private schedulePoll(): void {
    if (!this.foreground || this.pollTimer !== null) return;
    if (![...this.items.values()].some(isInFlight)) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().finally(() => this.schedulePoll());
    }, POLL_INTERVAL_MS);
  }

  private cancelPoll(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** One writer at a time: a poll must never race the recording it is about to read. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
