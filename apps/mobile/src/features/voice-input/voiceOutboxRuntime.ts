import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { File, FileMode } from "expo-file-system";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../../connection/runtime";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentSession } from "../../state/session";

import { uuidv4 } from "../../lib/uuid";
import { showVoiceDelivery, voiceUploadSupported } from "../../native/voiceUpload";
import {
  flushComposerDrafts,
  getComposerDraftSnapshot,
  setComposerDraftText,
} from "../../state/use-composer-drafts";
import { VoiceLivePreview, type VoiceLiveClient } from "./voiceLivePreview";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { currentMessageAuthorName } from "../../state/message-author";
import {
  enqueueThreadOutboxMessage,
  threadOutboxManager,
  updateThreadOutboxMessage,
  type QueuedThreadMessage,
} from "../../state/thread-outbox";
import { removeThreadOutboxMessage } from "../../state/thread-outbox-removal";
import {
  VoiceOutbox,
  type VoiceHeldMessage,
  type VoiceOutboxItem,
  type VoiceServerClient,
} from "./voiceOutbox";
import { voiceOutboxFileStore } from "./voiceOutboxStore";
import {
  threadVoiceStatus,
  VOICE_MESSAGE_LABEL,
  voiceDeliveryNotice,
  voicePreviewText,
} from "./voiceThreadMessages";
import { chooseVoiceServer, type VoiceAccessAnswer } from "./voiceAccess";
import {
  createVoiceServerClient,
  readVoiceServerConfig,
  writeVoiceServerConfig,
  type VoiceServerConfig,
} from "./voiceServer";

let server: VoiceServerConfig | null = null;
let client: (VoiceServerClient & VoiceLiveClient) | null = null;
let started = false;
let deliveryKey: string | null = null;
const serverListeners = new Set<() => void>();
const draftSubmitListeners = new Set<(ownerKey: string) => void>();

function deviceLanguage(): string {
  const language = Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0] ?? "";
  return /^[a-z]{2,3}$/.test(language) ? language : "auto";
}

/** Flushed before returning so the outbox can safely forget the recording. */
async function appendDraftText(ownerKey: string, text: string): Promise<void> {
  await flushComposerDrafts();
  const current = getComposerDraftSnapshot(ownerKey).text;
  // A crash after the text landed retries this; the same words must not appear twice.
  if (current.includes(text)) return;
  setComposerDraftText(ownerKey, current ? `${current.trimEnd()}\n\n${text}` : text);
  await flushComposerDrafts();
}

/** Opened per read: the recorder keeps growing the file, and a handle may cache its size. */
async function readRecordedBytes(uri: string, offset: number, maxBytes: number) {
  const handle = new File(uri).open(FileMode.ReadOnly);
  try {
    handle.offset = offset;
    return await handle.readBytes(maxBytes);
  } finally {
    handle.close();
  }
}

export type VoiceThreadStart = { readonly id: string; readonly placeholder: string };

const threadStartListeners = new Set<(key: string, start: VoiceThreadStart) => void>();

/** A freshly started app may poll before the outbox has been read back from disk. */
async function findHeldMessage(held: VoiceHeldMessage) {
  if (!(await threadOutboxManager.load())) throw new Error("The thread outbox is unreadable.");
  const queues = appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom);
  return Object.values(queues)
    .flat()
    .find((message) => message.messageId === held.messageId);
}

/** "auto" as in the composer: an agent that finished meanwhile gets a new turn, not an error. */
const steerDispatchMode = (steers: boolean) => (steers ? "auto" : "queue");

const voiceLivePreview = new VoiceLivePreview({
  getClient: () => client,
  readAudio: readRecordedBytes,
});

export const voiceOutbox = new VoiceOutbox({
  store: voiceOutboxFileStore,
  getClient: () => client,
  appendDraft: appendDraftText,
  submitDraft: (ownerKey) => {
    for (const listener of draftSubmitListeners) listener(ownerKey);
  },
  startThread: (ownerKey, id, previewText) => {
    const start = { id, placeholder: voicePreviewText(previewText) || VOICE_MESSAGE_LABEL };
    for (const listener of threadStartListeners) listener(ownerKey, start);
  },
  heldMessages: {
    release: async (held, text) => {
      const message = await findHeldMessage(held);
      if (!message) return false;
      const { awaitingVoiceId, ...rest } = message;
      return awaitingVoiceId === undefined || updateThreadOutboxMessage({ ...rest, text });
    },
    remove: async (held) => {
      const message = await findHeldMessage(held);
      if (message) await removeThreadOutboxMessage(message);
    },
    setSteering: async (held, steers) => {
      const message = await findHeldMessage(held);
      if (!message) return false;
      return updateThreadOutboxMessage({ ...message, dispatchMode: steerDispatchMode(steers) });
    },
  },
  live: voiceLivePreview,
  newId: () => `voice-${uuidv4()}`,
  language: deviceLanguage,
  speaker: currentMessageAuthorName,
  now: Date.now,
});

function applyServer(config: VoiceServerConfig | null): void {
  server = config;
  client = config ? createVoiceServerClient(config) : null;
  for (const listener of serverListeners) listener();
  voiceOutbox.resumeUploads();
}

export const getVoiceServer = () => server;

export function subscribeVoiceServer(listener: () => void): () => void {
  serverListeners.add(listener);
  return () => void serverListeners.delete(listener);
}

export const useVoiceServer = () => useSyncExternalStore(subscribeVoiceServer, getVoiceServer);

export const useVoiceOutboxItems = () =>
  useSyncExternalStore(voiceOutbox.subscribe, voiceOutbox.getSnapshot);

/** A primitive snapshot, so a chat row only renders again when its own status changes. */
export const useThreadVoiceStatus = (threadKey: string) =>
  useSyncExternalStore(voiceOutbox.subscribe, () =>
    threadVoiceStatus(voiceOutbox.getSnapshot(), threadKey),
  );

export const useVoiceLiveText = () =>
  useSyncExternalStore(voiceLivePreview.subscribe, voiceLivePreview.getText);

/** Calls back when a voice message of this composer has landed in its draft and should go out. */
export function useVoiceDraftSubmit(ownerKey: string, onSubmit: () => void): void {
  const submit = useEffectEvent(onSubmit);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the outbox, which lives outside React
  useEffect(() => {
    const listener = (key: string) => {
      if (key === ownerKey) submit();
    };
    draftSubmitListeners.add(listener);
    return () => void draftSubmitListeners.delete(listener);
  }, [ownerKey]);
}

/** Calls back when a recording in this new chat was sent, while it is still being transcribed. */
export function useVoiceThreadStart(
  ownerKey: string | null,
  onStart: (start: VoiceThreadStart) => void,
): void {
  const startThread = useEffectEvent(onStart);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the outbox, which lives outside React
  useEffect(() => {
    const listener = (key: string, start: VoiceThreadStart) => {
      if (key === ownerKey) startThread(start);
    };
    threadStartListeners.add(listener);
    return () => void threadStartListeners.delete(listener);
  }, [ownerKey]);
}

/** False when the transcript won the race: the draft then sends itself as usual. */
export function holdVoiceThreadMessage(
  voiceId: string,
  draftKey: string,
  typedText: string,
  message: QueuedThreadMessage,
): Promise<boolean> {
  const held = {
    environmentId: String(message.environmentId),
    threadId: String(message.threadId),
    messageId: String(message.messageId),
    draftKey,
    sendsAlone: typedText.length > 0 || message.attachments.length > 0,
    steers: message.dispatchMode === "auto",
  };
  return voiceOutbox.holdThreadMessage(
    voiceId,
    held,
    scopedThreadKey(message.environmentId, message.threadId),
    typedText,
    () => enqueueThreadOutboxMessage(message),
  );
}

/** Switches a sent recording between steering the agent and queueing behind it. */
export const setVoiceSteering = (item: VoiceOutboxItem, steers: boolean): Promise<void> =>
  voiceOutbox.setSteering(item.id, steers);

export const hasPendingVoice = (draftKey: string) =>
  voiceOutbox.pendingDraftItemId(draftKey) !== null;

/**
 * A message sent while its dictation is still transcribing waits for those words. The service
 * sends it when it can carry all of it, so the phone is free once the audio is uploaded; a
 * message that also changes the thread's settings (`serviceMaySend` false) leaves from the phone.
 */
export async function enqueueWithPendingVoice(
  draftKey: string,
  message: QueuedThreadMessage,
  options: { readonly serviceMaySend?: boolean } = {},
): Promise<void> {
  const voiceId = voiceOutbox.pendingDraftItemId(draftKey);
  if (voiceId === null) return enqueueThreadOutboxMessage(message);
  if (
    options.serviceMaySend &&
    message.attachments.length === 0 &&
    server?.environmentId === String(message.environmentId) &&
    (await voiceOutbox.sendThroughService(voiceId, {
      ownerKey: scopedThreadKey(message.environmentId, message.threadId),
      threadId: String(message.threadId),
      prefixText: message.text,
      steers: message.dispatchMode === "auto",
    }))
  ) {
    return;
  }
  const preview = voiceOutbox.getSnapshot().find((item) => item.id === voiceId)?.previewText;
  const words = voicePreviewText(preview) || VOICE_MESSAGE_LABEL;
  const text = [message.text, words].filter(Boolean).join("\n\n");
  const held = { ...message, text, awaitingVoiceId: voiceId };
  if (await holdVoiceThreadMessage(voiceId, draftKey, message.text, held)) return;
  // The transcript just landed in the draft, next to what the message was built from.
  const draftText = getComposerDraftSnapshot(draftKey).text.trim();
  return enqueueThreadOutboxMessage({ ...message, text: draftText });
}

const voiceAccessCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:voice:access",
  tag: WS_METHODS.voiceAccess,
});

async function askForVoiceAccess(environmentId: EnvironmentId): Promise<VoiceAccessAnswer> {
  const result = await runAtomCommand(
    appAtomRegistry,
    voiceAccessCommand,
    { environmentId, input: {} },
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag !== "Success") return "unknown";
  if (result.value.relativeUrl === null) return { url: null };
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  return Option.isNone(connection)
    ? "unknown"
    : { url: resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl) };
}

/** Saved first: the background upload and a later cold start read what was chosen here. */
async function lookUpVoiceAccess(environmentId: EnvironmentId): Promise<void> {
  const answer = await askForVoiceAccess(environmentId);
  const next = chooseVoiceServer(
    server,
    environmentId,
    answer,
    appAtomRegistry.get(connectedEnvironmentIdsAtom),
  );
  if (next?.url === server?.url) return;
  await writeVoiceServerConfig(next);
  applyServer(next);
}

/** Each (re)connect renews the URL, which also follows a relay address that changed meanwhile. */
function watchVoiceAccess(): void {
  let connected = new Set<EnvironmentId>();
  appAtomRegistry.subscribe(
    connectedEnvironmentIdsAtom,
    (environmentIds) => {
      for (const environmentId of environmentIds) {
        if (connected.has(environmentId)) continue;
        lookUpVoiceAccess(environmentId).catch((error: unknown) =>
          console.warn("[voice] looking up the voice service failed", error),
        );
      }
      connected = new Set(environmentIds);
    },
    { immediate: true },
  );
}

/** Android only starts the service from the foreground, so a refused start is retried there. */
function syncVoiceDelivery(force: boolean): void {
  const notice = voiceDeliveryNotice(voiceOutbox.getSnapshot());
  const key = notice ? `${notice.title}\n${notice.text}` : null;
  if (!force && key === deliveryKey) return;
  deliveryKey = key;
  showVoiceDelivery(notice);
}

/** Runs at launch, not with the first composer: waiting recordings must not depend on navigation. */
export function startVoiceOutbox(): void {
  if (started || !voiceUploadSupported) return;
  started = true;
  voiceOutbox.setForeground(AppState.currentState === "active");
  voiceOutbox.subscribe(() => syncVoiceDelivery(false));
  AppState.addEventListener("change", (state) => {
    voiceOutbox.setForeground(state === "active");
    if (state === "active") syncVoiceDelivery(true);
  });
  void readVoiceServerConfig()
    .catch(() => null)
    .then((config) => {
      if (config && server === null) applyServer(config);
      watchVoiceAccess();
      return voiceOutbox.recover();
    });
}
