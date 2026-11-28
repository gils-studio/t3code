import { useAtomValue } from "@effect/atom-react";
import { AudioModule, RecordingPresets, type RecordingStatus } from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import { makeMutable } from "react-native-reanimated";

import {
  type MicrophoneEntry,
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  voiceInputBlocksSubmission,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { createLazyVoiceRecorder, createRecorderFormatGuard } from "./lazyVoiceRecorder";
import { getVoiceServer, subscribeVoiceServer, useVoiceServer } from "./voiceOutboxRuntime";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
import { createVoiceRecordingPermission } from "./voiceRecordingPermission";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
};

// ADTS has no trailer, so audio written before a crash or kill stays decodable.
const VOICE_SERVER_RECORDING_OPTIONS = {
  ...VOICE_RECORDING_OPTIONS,
  extension: ".aac",
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 48_000,
  outputFormat: "aac_adts",
  audioEncoder: "aac",
} as const;

function keepScreenAwake(tag: string): () => void {
  const activation = activateKeepAwakeAsync(tag);
  void activation.catch(() => {});
  // Release after activation settles, even if the recording ends immediately.
  return () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
}

export const deviceMicrophoneOrder = (saved?: ReadonlyArray<MicrophoneEntry>) =>
  microphoneOrder(saved, Platform.OS === "android" ? "android" : "ios");

/** "checking" until the first availability probe settles; re-probed on foreground. */
export const localVoiceTranscriberAtom = makePermissionStatusAtom<
  VoiceTranscriber | null | "checking"
>({
  label: "mobile:voice-input:transcriber",
  initial: "checking",
  read: () => getLocalVoiceTranscriber().catch(() => null),
}).pipe(Atom.keepAlive);

// Each foreground re-probe yields a new transcriber; composers re-render only when availability flips.
const localVoiceInputAvailableAtom = Atom.make((get) => {
  const transcriber = get(localVoiceTranscriberAtom);
  return transcriber !== null && transcriber !== "checking";
});

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the registry's lifetime rather than any screen's.
 */
const voiceInputAtom = Atom.make((get) => {
  const registry = get.registry;
  // Mounted so the recorder can read and remember microphones synchronously.
  get.mount(mobilePreferencesAtom);
  get.mount(updateMobilePreferencesAtom);
  get.mount(localVoiceTranscriberAtom);
  const audioLevels = makeMutable<ReadonlyArray<number>>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  const permission = createVoiceRecordingPermission(() => {
    void session.controller.appMovedToBackground();
  });
  const recorderFormat = createRecorderFormatGuard<boolean>({
    release: () => recorder.release(),
    isBusy: () => voiceInputBlocksSubmission(session.getSnapshot().state),
  });
  const recorder = createLazyVoiceRecorder({
    create: () => {
      const forServer = getVoiceServer() !== null;
      recorderFormat.built(forServer);
      return new AudioModule.AudioRecorder(
        forServer ? VOICE_SERVER_RECORDING_OPTIONS : VOICE_RECORDING_OPTIONS,
      );
    },
    onStatus: (status: RecordingStatus) => {
      session.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      });
    },
    // Android waits up to 5 s for a headset's communication route; iOS switches inputs at once.
    selectInputWhileRecording: Platform.OS === "android",
    // Read when recording starts so preference changes do not re-render every composer.
    selectInput: (inputs) => {
      const preferences = registry.get(mobilePreferencesAtom);
      if (!AsyncResult.isSuccess(preferences)) return null;
      const known = deviceMicrophoneOrder(preferences.value.microphones);
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        registry.set(updateMobilePreferencesAtom, {
          transform: (current) => ({
            microphones: rememberMicrophones(deviceMicrophoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    getTranscriber: () => {
      const transcriber = registry.get(localVoiceTranscriberAtom);
      return transcriber === "checking" ? null : transcriber;
    },
    requestPermission: permission.requestPermission,
    configureRecording: async () => {
      const token = acquireAudioSession("recording");
      audioToken = token;
      try {
        await activateAudioSession(token);
      } catch (error) {
        await releaseAudioSession(token).catch(() => {});
        throw error;
      }
    },
    releaseRecording: async () => {
      if (audioToken) await releaseAudioSession(audioToken);
      audioToken = null;
    },
    deleteRecording: (uri) => new File(uri).delete(),
    sampleRecording: () => {
      const status = recorder.getStatus();
      return status?.isRecording
        ? { durationMillis: status.durationMillis, metering: status.metering }
        : null;
    },
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
  });
  // Each reconnect renews the voice URL; only gaining or losing the service changes the format.
  const unsubscribeServer = subscribeVoiceServer(() =>
    recorderFormat.want(getVoiceServer() !== null),
  );
  const unsubscribeSession = session.subscribe(recorderFormat.settle);
  get.addFinalizer(() => {
    unsubscribeServer();
    unsubscribeSession();
    permission.dispose();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

/** Whether a dictation runs anywhere in the app, for work that must not cut into it. */
export function isVoiceInputBusy(): boolean {
  return voiceInputBlocksSubmission(
    appAtomRegistry.get(voiceInputAtom).session.getSnapshot().state,
  );
}

export function useVoiceInputSession(): VoiceInputSession {
  return useAtomValue(voiceInputAtom).session;
}

/** Re-renders only when a dictation into this composer starts or ends, not on every recording tick. */
export function useIsDictatingInto(ownerKey: string | null): boolean {
  const session = useVoiceInputSession();
  return useSyncExternalStore(session.subscribe, () => {
    const snapshot = session.getSnapshot();
    return (
      ownerKey !== null &&
      snapshot.ownerKey === ownerKey &&
      voiceInputBlocksSubmission(snapshot.state)
    );
  });
}

export function useGlobalVoiceInput() {
  const { session, audioLevels } = useAtomValue(voiceInputAtom);
  const isTranscriberAvailable = useAtomValue(localVoiceInputAvailableAtom);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const server = useVoiceServer();
  return {
    ...snapshot,
    isAvailable: isTranscriberAvailable || getNativeShowcaseScene() !== null,
    server,
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    send: () => session.controller.stop("send"),
    cancel: () => session.controller.cancel(),
  };
}
