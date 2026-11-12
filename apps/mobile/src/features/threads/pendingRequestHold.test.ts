import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { describe, expect, it } from "vite-plus/test";

import { isPendingRequestHeldBack } from "./pendingRequestHold";

const base = {
  requestId: "request-1",
  openedRequestId: null,
  composerKey: "thread:1",
  voiceOwnerKey: null,
  draftHasMessage: false,
};
const voice = (phase: VoiceInputPhase) => ({ phase, error: null, errorAction: null });

describe("isPendingRequestHeldBack", () => {
  it.each([
    ["no question", { requestId: null, voiceOwnerKey: "thread:1" }, "recording", false],
    ["idle composer", {}, "idle", false],
    ["recording here", { voiceOwnerKey: "thread:1" }, "recording", true],
    ["preparing here", { voiceOwnerKey: "thread:1" }, "preparing", true],
    ["transcribing here", { voiceOwnerKey: "thread:1" }, "transcribing", true],
    ["dictation failed here", { voiceOwnerKey: "thread:1" }, "error", false],
    ["recording elsewhere", { voiceOwnerKey: "thread:2" }, "recording", false],
    ["unsent draft", { draftHasMessage: true }, "idle", true],
    ["opened over a draft", { openedRequestId: "request-1", draftHasMessage: true }, "idle", false],
    [
      "opened during a dictation",
      { openedRequestId: "request-1", voiceOwnerKey: "thread:1" },
      "recording",
      true,
    ],
    [
      "a newer question after opening an older one",
      { openedRequestId: "request-0", draftHasMessage: true },
      "idle",
      true,
    ],
  ] as const)("%s", (_name, overrides, phase, expected) => {
    expect(isPendingRequestHeldBack({ ...base, ...overrides, voiceState: voice(phase) })).toBe(
      expected,
    );
  });
});
