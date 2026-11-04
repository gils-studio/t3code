const TICK_INTERVAL_MS = 1_000;
const MAX_CHUNK_BYTES = 256 * 1024;
const VISIBLE_TAIL_CHARACTERS = 120;

export type VoiceLiveClient = {
  sendLiveAudio(
    id: string,
    offset: number,
    bytes: Uint8Array,
    language: string,
  ): Promise<{ readonly received: number; readonly text: string }>;
};

export type VoiceLivePreviewDependencies = {
  readonly getClient: () => VoiceLiveClient | null;
  readonly readAudio: (uri: string, offset: number, maxBytes: number) => Promise<Uint8Array>;
};

type Session = {
  readonly id: string;
  readonly uri: string;
  readonly language: string;
  offset: number;
};

/** Android can only ellipsize the end of multi-line text, so the cut at the start is done here. */
export function voiceLiveTail(text: string): string {
  if (text.length <= VISIBLE_TAIL_CHARACTERS) return text;
  const tail = text.slice(-VISIBLE_TAIL_CHARACTERS);
  return `…${tail.slice(tail.indexOf(" ") + 1)}`;
}

/**
 * Streams the growing recording file to the voice server and holds the words it
 * has heard so far. The first tick has no audio yet: it only makes the server
 * load the model while the user starts talking. Every failure is ignored, since
 * the recording itself is delivered by the outbox whatever happens here.
 */
export class VoiceLivePreview {
  private readonly dependencies: VoiceLivePreviewDependencies;
  private readonly listeners = new Set<() => void>();
  private session: Session | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private text = "";

  constructor(dependencies: VoiceLivePreviewDependencies) {
    this.dependencies = dependencies;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readonly getText = () => this.text;

  start(id: string, uri: string, language: string): void {
    this.stop();
    const session = { id, uri, language, offset: 0 };
    this.session = session;
    void this.tick(session);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.session = null;
    this.setText("");
  }

  private async tick(session: Session): Promise<void> {
    try {
      const client = this.dependencies.getClient();
      if (client) {
        const bytes = await this.dependencies.readAudio(
          session.uri,
          session.offset,
          MAX_CHUNK_BYTES,
        );
        const answer = await client.sendLiveAudio(
          session.id,
          session.offset,
          bytes,
          session.language,
        );
        if (this.session !== session) return;
        session.offset = answer.received;
        this.setText(answer.text);
      }
    } catch {
      // Offline or a server restart: the next tick asks again from the same position.
    }
    if (this.session !== session) return;
    this.timer = setTimeout(() => void this.tick(session), TICK_INTERVAL_MS);
  }

  private setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    for (const listener of this.listeners) listener();
  }
}
