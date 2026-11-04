import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import type { VoiceOutboxItem } from "./voiceOutbox";
import { voiceQueueItems, withVoiceMessages } from "./voiceThreadMessages";

const item = (overrides: Partial<VoiceOutboxItem>): VoiceOutboxItem => ({
  id: "voice-1",
  ownerKey: "thread-key",
  threadId: "thread",
  mode: "send",
  submitDraft: false,
  prefixText: "",
  language: "de",
  sourceUri: null,
  phase: "processing",
  remoteStatus: "transcribing",
  queuePosition: null,
  error: null,
  createdAt: 1,
  ...overrides,
});

const heldMessage = {
  environmentId: "env",
  threadId: "thread",
  messageId: "message",
  draftKey: "thread-key",
  sendsAlone: false,
};
const held = { messageId: "message", awaitingVoiceId: "voice-1" } as QueuedThreadMessage;
const thread = (agentBusy: boolean) => ({
  environmentId: "env" as EnvironmentId,
  threadId: "thread" as ThreadId,
  threadKey: "thread-key",
  agentBusy,
});

describe("voice messages of a thread", () => {
  it("shows a recording the service delivers as a chat row with what was typed and heard", () => {
    const [row] = withVoiceMessages(
      [],
      [item({ prefixText: "typed", previewText: "gehoert" })],
      thread(false),
    );
    expect(row).toMatchObject({ text: "typed\n\ngehoert […]", awaitingVoiceId: "voice-1" });
  });

  it("moves transcribing messages from the chat to the queue while the agent works", () => {
    const items = [item({}), item({ id: "voice-2", mode: "draft", heldMessage })];
    const queued = [{ ...held, awaitingVoiceId: "voice-2" }];
    expect(withVoiceMessages(queued, items, thread(true))).toEqual([]);
    expect(voiceQueueItems(items, "thread-key", true).map(({ id }) => id)).toEqual([
      "voice-1",
      "voice-2",
    ]);
    expect(voiceQueueItems(items, "thread-key", false)).toEqual([]);
  });

  it("keeps a failed recording in the chat, where its retry cannot be missed", () => {
    const items = [item({ phase: "failed" })];
    expect(voiceQueueItems(items, "thread-key", true)).toEqual([]);
    expect(withVoiceMessages([], items, thread(true))).toHaveLength(1);
  });

  it("leaves a dictation that returns to the composer alone", () => {
    const items = [item({ mode: "draft" }), item({ id: "voice-2", phase: "recording" })];
    expect(withVoiceMessages([], items, thread(false))).toEqual([]);
    expect(voiceQueueItems(items, "thread-key", true)).toEqual([]);
  });
});
