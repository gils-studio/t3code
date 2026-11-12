import type {
  VoiceRecordingDisposition,
  VoiceRecordingHandoff,
} from "@t3tools/client-runtime/voice-input";
import { voiceMessagePrefix } from "@t3tools/client-runtime/user-message";

export const VOICE_SERVER_RECORDING_LIMIT_SECONDS = 30 * 60;
const POLL_INTERVAL_MS = 1_000;
/** As long as the delivery service keeps the app alive; past it the app waits for its return. */
const BACKGROUND_POLL_LIMIT_MS = 30 * 60_000;

export type VoiceJob = {
  readonly status: "queued" | "transcribing" | "sending" | "done" | "failed";
  readonly transcript: string | null;
  readonly queuePosition: number | null;
  readonly lastError: string | null;
  /** Who this phone belongs to; the service knows it from the token. */
  readonly speaker?: string | null;
};

export type VoiceOutboxPhase = "recording" | "uploading" | "processing" | "no-speech" | "failed";

/** A message waiting in the thread outbox for this transcript. */
export type VoiceHeldMessage = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId: string;
  /** Where the text goes if the message is gone, say because the chat was deleted. */
  readonly draftKey: string;
  /** Typed text or attachments, which go out even if the recording yields no words. */
  readonly sendsAlone: boolean;
  /** Once set, a missing message most likely went out already. */
  readonly releasing?: boolean;
  /** Goes to the running agent the moment the words are in, instead of queueing behind it. */
  readonly steers?: boolean;
};

/** A recording the service would send, turned into a message the phone delivers. */
export type VoiceSteerHandover = {
  readonly held: VoiceHeldMessage;
  readonly enqueueMessage: () => Promise<void>;
};

export type VoiceOutboxItem = {
  readonly id: string;
  readonly ownerKey: string;
  readonly threadId: string | null;
  readonly mode: VoiceRecordingDisposition;
  /** Without a thread the service cannot send, so an open composer sends the finished draft. */
  readonly submitDraft: boolean;
  readonly heldMessage?: VoiceHeldMessage;
  readonly prefixText: string;
  /** The live words at the end of the recording, shown until the transcript replaces them. */
  readonly previewText?: string;
  readonly language: string;
  /** Who uses this phone, from its settings; the service falls back to the name it paired. */
  readonly speaker?: string;
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
  /** Takes sending away from the service; "too-late" once it started, "missing" before the upload. */
  claim(id: string): Promise<"claimed" | "too-late" | "missing">;
};

export type VoiceOutboxDependencies = {
  readonly store: VoiceOutboxStore;
  readonly getClient: () => VoiceServerClient | null;
  /** Must resolve only once the text is durably part of the draft. */
  readonly appendDraft: (ownerKey: string, text: string) => Promise<void>;
  /** Without a composer listening the text simply stays in the draft. */
  readonly submitDraft: (ownerKey: string) => void;
  /** An open new-chat screen answers by moving to a thread, see holdThreadMessage. */
  readonly startThread: (ownerKey: string, id: string, previewText: string) => void;
  readonly heldMessages: {
    /** False when the message no longer exists. */
    release(held: VoiceHeldMessage, text: string): Promise<boolean>;
    remove(held: VoiceHeldMessage): Promise<void>;
    /** False when the message no longer exists. */
    setSteering(held: VoiceHeldMessage, steers: boolean): Promise<boolean>;
  };
  /** Shows the words while they are spoken; the recording never depends on it. */
  readonly live: {
    start(id: string, uri: string, language: string): void;
    stop(): void;
    getText(): string;
  };
  readonly newId: () => string;
  readonly language: () => string;
  readonly speaker: () => string | undefined;
  readonly now: () => number;
};

export type VoiceHandoffTarget = {
  readonly ownerKey: string;
  /** Null for a draft without a thread yet; such recordings can only return to the draft. */
  readonly threadId: string | null;
  /** The service only sends text, so attachments have to leave through the composer. */
  readonly sendsThroughDraft: () => boolean;
  readonly readDraftText: () => string;
  readonly clearDraftText: () => void;
};

const withTranscript = (prefixText: string, transcript: string) =>
  prefixText ? `${prefixText.trimEnd()}\n\n${transcript}` : transcript;

export const isInFlight = (item: VoiceOutboxItem) =>
  item.phase === "uploading" || item.phase === "processing";

/** Sent, and nothing else can finish it: the audio is not on the server or the phone holds the message. */
export const needsPhone = (item: VoiceOutboxItem) =>
  isInFlight(item) &&
  (item.heldMessage !== undefined || (item.mode === "send" && item.phase === "uploading"));

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
  private backgroundedAt: number | null = null;

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
    this.backgroundedAt = foreground ? null : this.dependencies.now();
    if (foreground) this.resumeUploads();
    else if (this.shouldPoll()) this.schedulePoll();
    else this.cancelPoll();
  }

  createHandoff(target: VoiceHandoffTarget): VoiceRecordingHandoff {
    let id: string | null = null;
    const begin = (uri: string) => {
      const itemId = this.dependencies.newId();
      id = itemId;
      const speaker = this.dependencies.speaker();
      return this.persist({
        id: itemId,
        ownerKey: target.ownerKey,
        threadId: target.threadId,
        mode: "draft",
        submitDraft: false,
        prefixText: "",
        language: this.dependencies.language(),
        ...(speaker ? { speaker } : {}),
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
        const mode = target.threadId === null || target.sendsThroughDraft() ? "draft" : disposition;
        const prefixText = mode === "send" ? target.readDraftText() : "";
        void this.enqueue(async () => {
          const previewText = this.dependencies.live.getText();
          this.dependencies.live.stop();
          if (id === null) await begin(uri);
          const item = this.items.get(id!);
          if (!item) return;
          const submitDraft = disposition === "send" && mode === "draft";
          const finished = {
            ...item,
            mode,
            submitDraft,
            prefixText,
            sourceUri: uri,
            ...(previewText ? { previewText } : {}),
          };
          // The typed text may only leave the draft once it is stored with the recording.
          await this.persist(finished);
          if (mode === "send") target.clearDraftText();
          await this.deliver(finished);
          if (submitDraft) this.dependencies.startThread(target.ownerKey, id!, previewText);
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

  /** A recording of this draft whose words are still on their way. */
  pendingDraftItemId(ownerKey: string): string | null {
    const pending = this.snapshot.filter(
      (item) =>
        item.ownerKey === ownerKey &&
        item.mode === "draft" &&
        !item.heldMessage &&
        isInFlight(item),
    );
    return pending.at(-1)?.id ?? null;
  }

  /**
   * Ties a recording to a message, so nobody has to wait for the transcript
   * and it cannot be left behind. The link is stored first: a crash in between leaves a
   * recording without a message, which ends up in the draft, never the reverse.
   */
  holdThreadMessage(
    id: string,
    held: VoiceHeldMessage,
    ownerKey: string,
    prefixText: string,
    enqueueMessage: () => Promise<void>,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const item = this.items.get(id);
      if (!item || item.mode !== "draft" || item.heldMessage || !isInFlight(item)) return false;
      await this.persist({
        ...item,
        ownerKey,
        heldMessage: held,
        submitDraft: false,
        prefixText,
      });
      try {
        await enqueueMessage();
      } catch (error) {
        await this.persist(item);
        throw error;
      }
      return true;
    });
  }

  /**
   * Only the phone can steer, the service can only queue. So the message moves
   * into the thread outbox before the service gives the job up: a crash in
   * between leaves one held message that a later poll claims or removes, never two sends.
   */
  setSteering(id: string, steers: boolean, handover: () => VoiceSteerHandover): Promise<void> {
    return this.enqueue(async () => {
      const item = this.items.get(id);
      if (!item || !isInFlight(item)) return;
      const held = item.heldMessage;
      if (held) {
        if (await this.dependencies.heldMessages.setSteering(held, steers)) {
          await this.persist({ ...item, heldMessage: { ...held, steers } });
        }
        return;
      }
      if (!steers || item.mode !== "send") return;
      const next = handover();
      const holding = { ...item, heldMessage: { ...next.held, steers } };
      await this.persist(holding);
      try {
        await next.enqueueMessage();
      } catch (error) {
        await this.persist(item);
        throw error;
      }
      const client = this.dependencies.getClient();
      // Offline or not uploaded yet: the next poll claims it.
      if (client) await this.claimFromService(client, holding).catch(() => {});
    });
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
      if (item.heldMessage) await this.settleHeldMessage(item, item.heldMessage);
      else if (item.prefixText) {
        await this.dependencies.appendDraft(item.ownerKey, item.prefixText);
      }
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

  private async claimFromService(
    client: VoiceServerClient,
    item: VoiceOutboxItem,
  ): Promise<VoiceOutboxItem> {
    const answer = await client.claim(item.id);
    if (answer === "missing") return item;
    if (answer === "claimed") {
      const claimed: VoiceOutboxItem = { ...item, mode: "draft" };
      await this.persist(claimed);
      // Rewrites the upload metadata: uploading this again must not make the service send.
      await this.dependencies.store.adoptAudio(claimed);
      return claimed;
    }
    const { heldMessage, ...unheld } = item;
    if (heldMessage) await this.dependencies.heldMessages.remove(heldMessage);
    await this.persist(unheld);
    return unheld;
  }

  private async pollItem(client: VoiceServerClient, stored: VoiceOutboxItem): Promise<void> {
    const item =
      stored.mode === "send" && stored.heldMessage
        ? await this.claimFromService(client, stored)
        : stored;
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
    const held = item.heldMessage;
    if (!transcript) {
      if (held?.sendsAlone) {
        await this.releaseHeldMessage(held, item, item.prefixText);
        await client.acknowledge(item.id);
        await this.forget(item.id);
        return;
      }
      if (item.prefixText && !held) {
        await this.dependencies.appendDraft(item.ownerKey, item.prefixText);
      }
      await this.persist({ ...item, prefixText: "", phase: "no-speech", remoteStatus: job.status });
      return;
    }
    if (held) {
      await this.releaseHeldMessage(
        held,
        item,
        withTranscript(item.prefixText, transcript),
        voiceMessagePrefix(item.speaker ?? job.speaker),
      );
    } else if (item.mode === "draft") {
      await this.dependencies.appendDraft(item.ownerKey, transcript);
    }
    await client.acknowledge(item.id);
    await this.forget(item.id);
    if (item.submitDraft) this.dependencies.submitDraft(item.ownerKey);
  }

  private async releaseHeldMessage(
    held: VoiceHeldMessage,
    item: VoiceOutboxItem,
    text: string,
    marker = "",
  ): Promise<void> {
    if (!held.releasing) {
      await this.persist({ ...item, heldMessage: { ...held, releasing: true } });
    }
    const released = await this.dependencies.heldMessages.release(held, `${marker}${text}`);
    if (!released && !held.releasing) await this.dependencies.appendDraft(held.draftKey, text);
  }

  /** Typed text and attachments still go out; a message that would stay empty goes away. */
  private async settleHeldMessage(item: VoiceOutboxItem, held: VoiceHeldMessage): Promise<void> {
    if (held.sendsAlone) await this.releaseHeldMessage(held, item, item.prefixText);
    else await this.dependencies.heldMessages.remove(held);
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
    if (this.pollTimer !== null || !this.shouldPoll()) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().finally(() => this.schedulePoll());
    }, POLL_INTERVAL_MS);
  }

  /** In the background only sent messages that still need this phone; a dictation waits for its return. */
  private shouldPoll(): boolean {
    const items = [...this.items.values()];
    if (this.foreground) return items.some(isInFlight);
    return (
      this.backgroundedAt !== null &&
      this.dependencies.now() - this.backgroundedAt < BACKGROUND_POLL_LIMIT_MS &&
      items.some(needsPhone)
    );
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
