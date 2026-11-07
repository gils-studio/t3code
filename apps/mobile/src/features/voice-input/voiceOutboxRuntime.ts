import { File, FileMode } from "expo-file-system";
import * as Linking from "expo-linking";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { Alert, AppState } from "react-native";

import { CommandId, MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";

import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { uuidv4 } from "../../lib/uuid";
import { voiceUploadSupported } from "../../native/voiceUpload";
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
import { VOICE_MESSAGE_LABEL, voiceItemText, voicePreviewText } from "./voiceThreadMessages";
import {
  createVoiceServerClient,
  deleteVoiceServerConfig,
  fetchVoiceServerConfig,
  isVoicePairLink,
  parseVoicePairLink,
  readVoiceServerConfig,
  writeVoiceServerConfig,
  type VoiceServerConfig,
} from "./voiceServer";

let server: VoiceServerConfig | null = null;
let client: (VoiceServerClient & VoiceLiveClient) | null = null;
let started = false;
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
export function setVoiceSteering(
  item: VoiceOutboxItem,
  steers: boolean,
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): Promise<void> {
  return voiceOutbox.setSteering(item.id, steers, () => {
    const metadata = makeQueuedMessageMetadata();
    const message: QueuedThreadMessage = {
      ...target,
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text: voiceItemText(item),
      attachments: [],
      dispatchMode: steerDispatchMode(steers),
      awaitingVoiceId: item.id,
      createdAt: new Date(item.createdAt).toISOString(),
    };
    return {
      held: {
        environmentId: String(target.environmentId),
        threadId: String(target.threadId),
        messageId: String(message.messageId),
        draftKey: item.ownerKey,
        sendsAlone: item.prefixText.length > 0,
      },
      enqueueMessage: () => enqueueThreadOutboxMessage(message),
    };
  });
}

export const hasPendingVoice = (draftKey: string) =>
  voiceOutbox.pendingDraftItemId(draftKey) !== null;

/** A message sent while its dictation is still transcribing waits for those words. */
export async function enqueueWithPendingVoice(
  draftKey: string,
  message: QueuedThreadMessage,
): Promise<void> {
  const voiceId = voiceOutbox.pendingDraftItemId(draftKey);
  if (voiceId === null) return enqueueThreadOutboxMessage(message);
  const preview = voiceOutbox.getSnapshot().find((item) => item.id === voiceId)?.previewText;
  const words = voicePreviewText(preview) || VOICE_MESSAGE_LABEL;
  const text = [message.text, words].filter(Boolean).join("\n\n");
  const held = { ...message, text, awaitingVoiceId: voiceId };
  if (await holdVoiceThreadMessage(voiceId, draftKey, message.text, held)) return;
  // The transcript just landed in the draft, next to what the message was built from.
  const draftText = getComposerDraftSnapshot(draftKey).text.trim();
  return enqueueThreadOutboxMessage({ ...message, text: draftText });
}

export async function pairVoiceServer(link: string): Promise<void> {
  const pairing = parseVoicePairLink(link);
  if (!pairing) throw new Error("This is not a voice server link.");
  const config = await fetchVoiceServerConfig(pairing);
  await writeVoiceServerConfig(config);
  applyServer(config);
}

/** Recordings still in the outbox stay there and continue after pairing again. */
export async function forgetVoiceServer(): Promise<void> {
  await deleteVoiceServerConfig();
  applyServer(null);
}

function handlePairLink(link: string | null): void {
  if (!link || !isVoicePairLink(link)) return;
  pairVoiceServer(link).then(
    () => Alert.alert("Voice server connected", "Recordings now transcribe on your computer."),
    (error: unknown) =>
      Alert.alert(
        "Could not connect the voice server",
        error instanceof Error ? error.message : String(error),
      ),
  );
}

/** Runs at launch, not with the first composer: waiting recordings must not depend on navigation. */
export function startVoiceOutbox(): void {
  if (started || !voiceUploadSupported) return;
  started = true;
  voiceOutbox.setForeground(AppState.currentState === "active");
  AppState.addEventListener("change", (state) => voiceOutbox.setForeground(state === "active"));
  Linking.addEventListener("url", ({ url }) => handlePairLink(url));
  void Linking.getInitialURL().then(handlePairLink);
  void readVoiceServerConfig()
    .catch(() => null)
    .then((config) => {
      if (config && server === null) applyServer(config);
      return voiceOutbox.recover();
    });
}
