import { describe, expect, it, vi } from "vite-plus/test";

import { VoiceInputController } from "@t3tools/client-runtime/voice-input";

import { resetVoiceInputGlobalsForTests } from "../../../../../packages/client-runtime/src/voice-input/controller";

import {
  createLazyVoiceRecorder,
  createRecorderFormatGuard,
  type VoiceRecordingInput,
} from "./lazyVoiceRecorder";

type Status = { readonly isFinished: boolean };
type State = { readonly isRecording: boolean };

function createNativeRecorder(uri: string) {
  const listeners = new Set<(status: Status) => void>();
  // Like expo-audio on Android, preparing again requires a stop in between.
  let isPrepared = false;
  return {
    uri: null as string | null,
    prepared: uri,
    prepareToRecordAsync: vi.fn(async function (this: { uri: string | null; prepared: string }) {
      if (isPrepared) throw new Error("Recorder is already prepared");
      isPrepared = true;
      this.uri = this.prepared;
    }),
    record: vi.fn(),
    stop: vi.fn(async (): Promise<void> => {
      isPrepared = false;
    }),
    getStatus: vi.fn((): State => ({ isRecording: true })),
    addListener: vi.fn((_event: "recordingStatusUpdate", listener: (status: Status) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    }),
    getAvailableInputs: vi.fn((): ReadonlyArray<VoiceRecordingInput> => [
      { uid: "car", name: "CarPlay", type: "CarAudio" },
      { uid: "built-in", name: "iPhone Microphone", type: "MicrophoneBuiltIn" },
    ]),
    setInput: vi.fn((_uid: string): void | Promise<void> => undefined),
    cancelInputSelection: vi.fn((): void => undefined),
    release: vi.fn(),
    emit: (status: Status) => listeners.forEach((listener) => listener(status)),
  };
}

function createHarness(
  selectInput?: (inputs: ReadonlyArray<VoiceRecordingInput>) => VoiceRecordingInput | null,
  configure?: (native: ReturnType<typeof createNativeRecorder>) => void,
  selectInputWhileRecording = false,
) {
  const created: Array<ReturnType<typeof createNativeRecorder>> = [];
  const statuses: Status[] = [];
  const recorder = createLazyVoiceRecorder({
    create: () => {
      const native = createNativeRecorder(`file:///voice-${created.length}.m4a`);
      configure?.(native);
      created.push(native);
      return native;
    },
    onStatus: (status) => statuses.push(status),
    ...(selectInput ? { selectInput } : {}),
    selectInputWhileRecording,
  });
  return { recorder, created, statuses };
}

describe("createLazyVoiceRecorder", () => {
  it("keeps the system input when none is preferred or the preferred one disconnects", async () => {
    const unpreferred = createHarness(() => null);
    await unpreferred.recorder.prepareToRecordAsync();
    expect(unpreferred.created[0]!.setInput).not.toHaveBeenCalled();

    const disconnected = createHarness((inputs) => inputs[1] ?? null);
    await disconnected.recorder.prepareToRecordAsync();
    await disconnected.recorder.stop();
    disconnected.created[0]!.setInput.mockImplementationOnce(() => {
      throw new Error("Preferred input not found");
    });
    await expect(disconnected.recorder.prepareToRecordAsync()).resolves.toBeUndefined();

    const timedOut = createHarness(
      (inputs) => inputs[1] ?? null,
      (native) => {
        native.setInput.mockImplementationOnce(() =>
          Promise.reject(new Error("Routing timed out")),
        );
      },
    );
    await expect(timedOut.recorder.prepareToRecordAsync()).resolves.toBeUndefined();
  });

  it("forwards status events until the recorder is released", async () => {
    const { recorder, created, statuses } = createHarness();
    await recorder.prepareToRecordAsync();
    const native = created[0]!;

    native.emit({ isFinished: true });
    recorder.release();
    native.emit({ isFinished: false });

    expect(statuses).toEqual([{ isFinished: true }]);
  });

  it("rebuilds for a new format only once no dictation needs the recorder", () => {
    let busy = true;
    const release = vi.fn();
    const format = createRecorderFormatGuard<boolean>({ release, isBusy: () => busy });
    format.built(true);

    // A reconnect renews the voice URL; the format stays the same.
    format.want(true);
    format.want(false);
    expect(release).not.toHaveBeenCalled();

    busy = false;
    format.settle();
    expect(release).toHaveBeenCalledTimes(1);

    format.want(true);
    format.settle();
    expect(release).toHaveBeenCalledTimes(1);
  });

  describe("with the voice input controller", () => {
    function createController(
      granted: boolean,
      selectInput?: (inputs: ReadonlyArray<VoiceRecordingInput>) => VoiceRecordingInput | null,
      configure?: (native: ReturnType<typeof createNativeRecorder>) => void,
      selectInputWhileRecording = false,
    ) {
      // A controller left recording by an earlier case still holds the app-wide session.
      resetVoiceInputGlobalsForTests();
      const harness = createHarness(selectInput, configure, selectInputWhileRecording);
      const deleted: string[] = [];
      const controller = new VoiceInputController({
        recorder: harness.recorder,
        getTranscriber: () => ({
          prepare: async () => ({ locale: "en-US", transcribe: async () => "text" }),
        }),
        requestPermission: async () => ({ granted, canAskAgain: true }),
        configureRecording: async () => undefined,
        releaseRecording: async () => undefined,
        deleteRecording: (uri) => deleted.push(uri),
        readDraft: () => ({
          ownerKey: "thread",
          text: "",
          selection: { start: 0, end: 0 },
          revision: 0,
        }),
        commitDraft: () => undefined,
        onStateChange: () => undefined,
      });
      return { ...harness, controller, deleted };
    }

    it("does not create a native recorder when microphone permission is denied", async () => {
      const { controller, created } = createController(false);

      await controller.start();

      expect(controller.currentState.phase).toBe("error");
      expect(created).toHaveLength(0);
    });

    it("abandons a pending input route when dictation is canceled", async () => {
      const routing = Promise.withResolvers<void>();
      const { controller, created } = createController(
        true,
        (inputs) => inputs[1] ?? null,
        (native) => {
          // Expo drops the promise of a canceled coroutine function, so it never settles.
          native.setInput.mockImplementationOnce(() => {
            routing.resolve();
            return new Promise(() => undefined);
          });
        },
      );
      const starting = controller.start();
      await routing.promise;
      controller.cancel();
      await starting;
      expect(created[0]!.cancelInputSelection).toHaveBeenCalled();
      expect(controller.currentState.phase).toBe("idle");

      await controller.start();
      expect(controller.currentState.phase).toBe("recording");
    });

    it("records while a slow input route is still switching, and abandons it on stop", async () => {
      const routing = Promise.withResolvers<void>();
      const { controller, created } = createController(
        true,
        (inputs) => inputs[1] ?? null,
        (native) => {
          native.setInput.mockImplementationOnce(() => {
            routing.resolve();
            return new Promise(() => undefined);
          });
        },
        true,
      );

      await controller.start();
      await routing.promise;
      const native = created[0]!;
      expect(controller.currentState.phase).toBe("recording");
      expect(native.record.mock.invocationCallOrder[0]).toBeLessThan(
        native.setInput.mock.invocationCallOrder[0]!,
      );

      await controller.stop();
      expect(native.cancelInputSelection).toHaveBeenCalled();
      expect(controller.currentState.phase).toBe("idle");
    });
  });
});
