import {
  type ChatAttachment,
  type ChatFileAttachment,
  type GuestMessageAttribution,
  type OrchestrationMessageContext,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  type OrchestrationV2UserMessageInputIntent,
  ScheduledTaskId,
} from "@t3tools/contracts";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";

/** The working row while T3 Code's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted before sending",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

/**
 * Tells the agent that the words were dictated, and by whom when the voice service knows the
 * phone. People see the name under the message instead. tools/voice-server sends the same text.
 */
export const voiceMessagePrefix = (speaker?: string | null) =>
  speaker ? `[Voice message from ${speaker}]\n\n` : "[Voice message]\n\n";

/** Tells the agent who typed the message; people see the name under it instead. */
export const typedMessagePrefix = (author: string) => `[Message from ${author}]\n\n`;

const MESSAGE_MARKER = /^\[(?:Voice message(?: from ([^\]\r\n]+))?|Message from ([^\]\r\n]+))\]\n\n/;

/** Who a marker names and whether it marks dictation, or null for unmarked text. */
export function parseMessageMarker(text: string): {
  readonly length: number;
  readonly author: string | undefined;
  readonly voice: boolean;
} | null {
  const match = MESSAGE_MARKER.exec(text);
  if (match === null) return null;
  const author = (match[1] ?? match[2])?.trim();
  return { length: match[0].length, author: author || undefined, voice: match[2] === undefined };
}

export const stripMessageMarker = (text: string) =>
  text.slice(parseMessageMarker(text)?.length ?? 0);

/** A name that fits in a marker: one line, no closing bracket. */
export const normalizeMessageAuthor = (name: string | null | undefined) =>
  name?.replace(/[\]\r\n]/g, "").trim() || undefined;

/**
 * Names the author for the agent, unless the text already carries a marker or is a slash command,
 * which providers only recognize at the very start.
 */
export function withMessageAuthor(text: string, author: string | null | undefined): string {
  const name = normalizeMessageAuthor(author);
  return name && parseMessageMarker(text) === null && !text.trimStart().startsWith("/")
    ? `${typedMessagePrefix(name)}${text}`
    : text;
}

export function resolveUserMessageFileCards(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}): ReadonlyArray<ChatFileAttachment> | null {
  const files = message.attachments.filter(
    (attachment): attachment is ChatFileAttachment =>
      attachment.type === "file" &&
      imageMimeType(attachment) === null &&
      videoMimeType(attachment) === null &&
      filePreviewKind(attachment) !== "audio",
  );
  if (files.length === 0 || files.length !== message.attachments.length) return null;
  const fileIds = new Set(files.map((file) => file.id));
  const remaining = replaceComposerContextReferences(message.text, (reference) => {
    const record = message.context?.records.find((item) => item.contextId === reference.contextId);
    return reference.kind === "file" &&
      record?.kind === "file" &&
      "attachmentId" in record &&
      fileIds.has(record.attachmentId)
      ? ""
      : reference.label || reference.kind;
  });
  return remaining.trim() === "" ? files : null;
}

export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly senderThreadId?: string | undefined;
  readonly context?: { readonly guest?: GuestMessageAttribution | undefined } | undefined;
}): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | "guest" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  /** Set when `attribution` is "guest". */
  readonly guestName?: string;
  /** The user's own dictated words. */
  readonly voice?: boolean;
  /** Who wrote or dictated it, from its marker. */
  readonly author?: string;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  // The stored text names the guest for the agent; people see the guest's own words.
  const guest = message.context?.guest;
  if (guest !== undefined) {
    return {
      text: guest.text,
      attribution: "guest",
      scheduledTaskId: undefined,
      guestName: guest.name,
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  // The voice service sends through T3's CLI, which files the user's words under "agent".
  // Agents in a thread always carry a sender, so they cannot pass as the user this way.
  const marker = parseMessageMarker(message.text);
  if (marker !== null && (message.createdBy !== "agent" || message.senderThreadId === undefined)) {
    const text = message.text.slice(marker.length);
    return {
      text: isAttachmentOnlyBootstrapPrompt(text) ? "" : text,
      attribution: null,
      scheduledTaskId: undefined,
      ...(marker.voice ? { voice: true } : {}),
      ...(marker.author === undefined ? {} : { author: marker.author }),
    };
  }
  return {
    // The agent needs words to start a turn; people sent only the attachments.
    text: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}

type GroupableUserMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

export function resolveUserMessageGrouping(
  message: GroupableUserMessage | undefined,
  previous: GroupableUserMessage | undefined,
  next: GroupableUserMessage | undefined,
) {
  const isOwnMessage = (value: GroupableUserMessage | undefined) =>
    value?.role === "user" && resolveUserMessagePresentation(value).attribution === null;
  const isSteer = (value: GroupableUserMessage | undefined) =>
    value?.inputIntent === "steer" || value?.inputIntent === "promoted_queued_to_steer";
  const groupedWithPrevious = isOwnMessage(message) && isOwnMessage(previous);
  return {
    groupedWithPrevious,
    groupedWithNext: isOwnMessage(message) && isOwnMessage(next),
    continuesSteer: groupedWithPrevious && isSteer(message) && isSteer(previous),
  };
}
