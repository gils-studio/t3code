import {
  throwIfVoiceTranscriptionAborted,
  type VoiceRecorder,
} from "@t3tools/client-runtime/voice-input";

type Subscription = { remove(): void };

export interface VoiceRecordingInput {
  readonly uid: string;
  readonly name: string;
  readonly type: string;
}

export interface NativeVoiceRecorder<TStatus, TRecorderState> {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(options: { readonly forDuration: number }): void;
  stop(): Promise<void>;
  getStatus(): TRecorderState;
  addListener(
    eventName: "recordingStatusUpdate",
    listener: (status: TStatus) => void,
  ): Subscription;
  getAvailableInputs(): ReadonlyArray<VoiceRecordingInput>;
  setInput(uid: string): void | Promise<void>;
  cancelInputSelection?(): void;
  release(): void;
}

export interface LazyVoiceRecorder<TRecorderState> extends VoiceRecorder {
  getStatus(): TRecorderState | null;
  release(): void;
}

/** Construct lazily: cold startup blocks JS for tens of milliseconds and most composers never record. */
export function createLazyVoiceRecorder<TStatus, TRecorderState>(input: {
  readonly create: () => NativeVoiceRecorder<TStatus, TRecorderState>;
  readonly onStatus: (status: TStatus) => void;
  readonly selectInput?: (inputs: ReadonlyArray<VoiceRecordingInput>) => VoiceRecordingInput | null;
  /** Start capturing first and route to the selected input while recording, because routing can take seconds. */
  readonly selectInputWhileRecording?: boolean;
}): LazyVoiceRecorder<TRecorderState> {
  let recorder: NativeVoiceRecorder<TStatus, TRecorderState> | null = null;
  let subscription: Subscription | null = null;
  let retired: NativeVoiceRecorder<TStatus, TRecorderState> | null = null;
  let retiredUri: string | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  let abandonInputSelection: (() => void) | null = null;
  let armedSelection: {
    readonly prepared: NativeVoiceRecorder<TStatus, TRecorderState>;
    readonly signal: AbortSignal | undefined;
  } | null = null;

  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending = Promise.allSettled([pending, promise]).then(() => undefined);
    return promise;
  };

  const selectPreferredInput = async (
    prepared: NativeVoiceRecorder<TStatus, TRecorderState>,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    if (!input.selectInput) return;
    let selected: VoiceRecordingInput | null;
    try {
      selected = input.selectInput(prepared.getAvailableInputs());
    } catch {
      return;
    }
    if (!selected) return;
    const uid = selected.uid;
    // Expo never settles a canceled coroutine function's promise, so stop waiting on abort.
    const abandoned = Promise.withResolvers<void>();
    const abandon = () => {
      prepared.cancelInputSelection?.();
      abandoned.resolve();
    };
    signal?.addEventListener("abort", abandon, { once: true });
    abandonInputSelection = abandon;
    try {
      await Promise.race([
        new Promise<void>((resolve) => resolve(prepared.setInput(uid))).catch(() => {}),
        abandoned.promise,
      ]);
      if (signal) throwIfVoiceTranscriptionAborted(signal);
    } finally {
      signal?.removeEventListener("abort", abandon);
      if (abandonInputSelection === abandon) abandonInputSelection = null;
    }
  };

  return {
    get uri() {
      if (recorder) return recorder.uri;
      return retired ? retired.uri : retiredUri;
    },
    prepareToRecordAsync(signal) {
      if (!recorder) {
        recorder = input.create();
        subscription = recorder.addListener("recordingStatusUpdate", input.onStatus);
      }
      const prepared = recorder;
      armedSelection = null;
      return track(
        prepared.prepareToRecordAsync().then(async () => {
          if (signal) throwIfVoiceTranscriptionAborted(signal);
          if (input.selectInputWhileRecording) {
            armedSelection = { prepared, signal };
            return;
          }
          await selectPreferredInput(prepared, signal);
        }),
      );
    },
    record(options) {
      if (!recorder) throw new Error("Voice recorder is not prepared.");
      recorder.record(options);
      const armed = armedSelection;
      armedSelection = null;
      if (armed?.prepared === recorder) {
        void track(selectPreferredInput(armed.prepared, armed.signal)).catch(() => {});
      }
    },
    stop() {
      armedSelection = null;
      abandonInputSelection?.();
      return recorder ? track(recorder.stop()) : Promise.resolve();
    },
    getStatus() {
      return recorder ? recorder.getStatus() : null;
    },
    release() {
      const released = recorder;
      if (!released) return;
      armedSelection = null;
      abandonInputSelection?.();
      recorder = null;
      subscription?.remove();
      subscription = null;
      retired = released;
      void pending.then(() => {
        if (retired === released) {
          retiredUri = released.uri;
          retired = null;
        }
        released.release();
      });
    },
  };
}

/**
 * A recorder's format is fixed when it is built. When the wanted format changes, the recorder is
 * rebuilt, but only once no dictation needs it: releasing it would cut off a running recording.
 */
export function createRecorderFormatGuard<TFormat>(input: {
  readonly release: () => void;
  readonly isBusy: () => boolean;
}) {
  let built: { readonly format: TFormat } | null = null;
  let wanted: TFormat | undefined;
  const settle = () => {
    if (built === null || Object.is(built.format, wanted) || input.isBusy()) return;
    built = null;
    input.release();
  };
  return {
    /** Called when the recorder is built, with the format it was built for. */
    built(format: TFormat) {
      built = { format };
      wanted = format;
    },
    want(format: TFormat) {
      wanted = format;
      settle();
    },
    /** Called whenever the dictation state changes, so a deferred rebuild happens once it is idle. */
    settle,
  };
}
