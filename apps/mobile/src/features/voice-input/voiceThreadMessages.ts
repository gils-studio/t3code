import type { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { isInFlight, needsPhone, type VoiceOutboxItem } from "./voiceOutbox";

export const VOICE_MESSAGE_LABEL = "Voice message";

/** Sent by the user: from here on it belongs to the thread, not to the composer. */
export const isSentVoiceItem = (item: VoiceOutboxItem) =>
  item.phase !== "recording" && (item.mode === "send" || item.heldMessage !== undefined);

/** The live words always trail the recording, so the end must not read as if words got lost. */
export const voicePreviewText = (previewText: string | undefined) =>
  previewText ? `${previewText.trimEnd()} […]` : "";

export const voiceItemText = (item: VoiceOutboxItem) =>
  [item.prefixText, voicePreviewText(item.previewText)].filter(Boolean).join("\n\n") ||
  VOICE_MESSAGE_LABEL;

/** "Uploaded" tells the user the recording no longer depends on this phone being on. */
function voiceProgressLabel(item: VoiceOutboxItem): string {
  if (item.phase === "uploading") return "Uploading recording";
  if (item.remoteStatus === "transcribing") return "Uploaded, transcribing";
  return item.queuePosition
    ? `Uploaded, ${item.queuePosition} ahead`
    : "Uploaded, waiting to transcribe";
}

export function voiceItemLabel(item: VoiceOutboxItem): string {
  if (item.phase === "no-speech") return "No speech found in the recording";
  if (item.phase === "failed") return item.error ?? "Transcription failed";
  if (item.remoteStatus === "sending") return "Sending message";
  const progress = voiceProgressLabel(item);
  return item.heldMessage?.steers ? `${progress}, then sends` : progress;
}

export type ThreadVoiceStatus = "uploading" | "transcribing" | "failed";

/** What a chat row shows for its sent recordings, before the agent has the message. */
export function threadVoiceStatus(
  items: ReadonlyArray<VoiceOutboxItem>,
  threadKey: string,
): ThreadVoiceStatus | null {
  const sent = items.filter((item) => item.ownerKey === threadKey && isSentVoiceItem(item));
  if (sent.some((item) => item.phase === "uploading")) return "uploading";
  if (sent.some(isInFlight)) return "transcribing";
  return sent.some((item) => item.phase === "failed") ? "failed" : null;
}

/** The notification that keeps the app alive while a sent recording still needs this phone. */
export function voiceDeliveryNotice(
  items: ReadonlyArray<VoiceOutboxItem>,
): { readonly title: string; readonly text: string } | null {
  const pending = items.filter(needsPhone);
  if (pending.length === 0) return null;
  return {
    title: pending.length === 1 ? "Sending voice message" : `Sending ${pending.length} voice messages`,
    text: pending.some((item) => item.phase === "uploading")
      ? "Uploading the recording"
      : "Transcribing on your computer, then this phone sends it",
  };
}

export const voiceItemSteers = (item: VoiceOutboxItem) => item.heldMessage?.steers === true;

/** A steering message can always be taken back, even if the agent stopped accepting steers. */
export const canToggleVoiceSteering = (item: VoiceOutboxItem, agentAcceptsSteering: boolean) =>
  item.remoteStatus !== "sending" && (agentAcceptsSteering || voiceItemSteers(item));

/** While the agent works these would queue behind it, so they show there and not in the chat. */
export function voiceQueueItems(
  items: ReadonlyArray<VoiceOutboxItem>,
  threadKey: string,
  agentBusy: boolean,
): ReadonlyArray<VoiceOutboxItem> {
  if (!agentBusy) return [];
  return items.filter(
    (item) => item.ownerKey === threadKey && isSentVoiceItem(item) && isInFlight(item),
  );
}

/** The service delivers plain recordings itself, so they get a chat row without an outbox entry. */
export function withVoiceMessages(
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
  items: ReadonlyArray<VoiceOutboxItem>,
  thread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly threadKey: string;
    readonly agentBusy: boolean;
  },
): ReadonlyArray<QueuedThreadMessage> {
  const inQueue = new Set(
    voiceQueueItems(items, thread.threadKey, thread.agentBusy).map((item) => item.id),
  );
  const rows = items
    .filter(
      (item) =>
        item.ownerKey === thread.threadKey &&
        isSentVoiceItem(item) &&
        item.heldMessage === undefined &&
        !inQueue.has(item.id),
    )
    .map((item): QueuedThreadMessage => ({
      environmentId: thread.environmentId,
      threadId: thread.threadId,
      messageId: item.id as MessageId,
      commandId: item.id as CommandId,
      text: voiceItemText(item),
      attachments: [],
      awaitingVoiceId: item.id,
      createdAt: new Date(item.createdAt).toISOString(),
    }));
  const kept = queuedMessages.filter(
    (message) => message.awaitingVoiceId === undefined || !inQueue.has(message.awaitingVoiceId),
  );
  return rows.length === 0 && kept.length === queuedMessages.length
    ? queuedMessages
    : [...kept, ...rows];
}
