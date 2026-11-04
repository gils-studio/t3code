import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { withoutNoiseMarkers } from "./worker.ts";
import type { SpeechSegment } from "./whisperServer.ts";

/** Whisper pads every run to 30 s, so a window below that costs one pass however long the talk. */
const COMMIT_AFTER_SECONDS = 15;
const SESSION_TIMEOUT_MILLIS = 5 * 60_000;
const WAV_BYTES_PER_SECOND = 32_000;

export type LiveResult = {
  readonly accepted: boolean;
  readonly received: number;
  readonly text: string;
};

export type LiveOptions = {
  readonly directory: string;
  readonly decode: (audio: string, wav: string, startSeconds: number) => Promise<void>;
  readonly isSilent: (wav: string) => Promise<boolean>;
  readonly recognize: (
    wav: string,
    language: string,
  ) => Promise<{ readonly segments: ReadonlyArray<SpeechSegment> }>;
  /** Finished recordings come first: the preview never delays a real transcript. */
  readonly isBusy: () => boolean;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
};

type Session = {
  readonly id: string;
  readonly language: string;
  received: number;
  lastSeenAt: number;
  hasNewAudio: boolean;
  committedText: string;
  windowText: string;
  windowStartSeconds: number;
};

/** Segments keep their own leading space and can end inside a word, so they are not joined by one. */
const textOf = (segments: ReadonlyArray<SpeechSegment>) =>
  segments
    .filter((segment) => withoutNoiseMarkers(segment.text).length > 0)
    .map((segment) => segment.text)
    .join("");

/**
 * A preview of the words while they are spoken. It is strictly best effort: the
 * final transcript comes from the uploaded recording and never reads this state.
 * Only the recent window is recognized again, so the cost stays flat as a talk grows.
 */
export class LiveTranscriber {
  private readonly options: LiveOptions;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Session>();
  private pumping: Promise<void> | null = null;

  constructor(options: LiveOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Audio of earlier runs is not needed by anything, and must not stay on disk. */
  async reset(): Promise<void> {
    await NodeFSP.rm(this.options.directory, { recursive: true, force: true });
    await NodeFSP.mkdir(this.options.directory, { recursive: true });
  }

  async append(
    id: string,
    offset: number,
    bytes: Uint8Array,
    language: string,
  ): Promise<LiveResult> {
    const session = this.sessions.get(id) ?? this.open(id, language);
    if (offset !== session.received) return this.result(session, false);
    await NodeFSP.appendFile(this.audioPath(id), bytes);
    session.received += bytes.length;
    session.lastSeenAt = this.now();
    session.hasNewAudio = bytes.length > 0 || session.hasNewAudio;
    void this.pump();
    return this.result(session, true);
  }

  async end(id: string): Promise<void> {
    this.sessions.delete(id);
    await this.removeFiles(id);
  }

  /** A discarded recording just stops talking to us, so its audio goes away on a timer. */
  async purgeIdle(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (this.now() - session.lastSeenAt > SESSION_TIMEOUT_MILLIS) await this.end(session.id);
    }
  }

  /** One update at a time, whoever asks; every caller gets the same run to wait on. */
  pump(): Promise<void> {
    this.pumping ??= this.drain().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const session = [...this.sessions.values()].find((candidate) => candidate.hasNewAudio);
      if (!session || this.options.isBusy()) return;
      session.hasNewAudio = false;
      await this.update(session).catch((error: unknown) =>
        this.options.log?.(`live update failed for ${session.id}: ${String(error)}`),
      );
    }
  }

  private open(id: string, language: string): Session {
    const session: Session = {
      id,
      language,
      received: 0,
      lastSeenAt: this.now(),
      hasNewAudio: false,
      committedText: "",
      windowText: "",
      windowStartSeconds: 0,
    };
    this.sessions.set(id, session);
    return session;
  }

  private async update(session: Session): Promise<void> {
    const wav = this.wavPath(session.id);
    try {
      await this.options.decode(this.audioPath(session.id), wav, session.windowStartSeconds);
      if (await this.options.isSilent(wav)) {
        const { size } = await NodeFSP.stat(wav);
        const seconds = size / WAV_BYTES_PER_SECOND;
        if (seconds > COMMIT_AFTER_SECONDS) this.advance(session, session.windowText, "", seconds);
        return;
      }
      const { segments } = await this.options.recognize(wav, session.language);
      const last = segments.at(-1);
      if (last && last.end > COMMIT_AFTER_SECONDS && segments.length > 1) {
        this.advance(session, textOf(segments.slice(0, -1)), textOf([last]), last.start);
      } else {
        session.windowText = textOf(segments);
      }
    } finally {
      // Windows refuses to delete a file in use, so end() may have left these behind.
      if (!this.sessions.has(session.id)) await this.removeFiles(session.id);
    }
  }

  private advance(session: Session, settled: string, rest: string, seconds: number): void {
    session.committedText += settled;
    session.windowText = rest;
    session.windowStartSeconds += seconds;
  }

  private result(session: Session, accepted: boolean): LiveResult {
    return {
      accepted,
      received: session.received,
      text: (session.committedText + session.windowText).trim(),
    };
  }

  private async removeFiles(id: string): Promise<void> {
    for (const file of [this.audioPath(id), this.wavPath(id)]) {
      await NodeFSP.rm(file, { force: true }).catch(() => {});
    }
  }

  private audioPath(id: string): string {
    return NodePath.join(this.options.directory, `${id}.aac`);
  }

  private wavPath(id: string): string {
    return NodePath.join(this.options.directory, `${id}.wav`);
  }
}
