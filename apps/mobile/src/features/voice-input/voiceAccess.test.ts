import { describe, expect, it } from "vite-plus/test";

import { chooseVoiceServer, type VoiceAccessAnswer } from "./voiceAccess";

const pc = { url: "https://pc/api/voice/old", environmentId: "pc" };

describe("chooseVoiceServer", () => {
  it.each<[string, typeof pc | null, string, VoiceAccessAnswer, string[], typeof pc | null]>([
    ["takes the first offer", null, "pc", { url: "https://pc/new" }, ["pc"], { url: "https://pc/new", environmentId: "pc" }],
    ["renews the chosen one", pc, "pc", { url: "https://pc/new" }, ["pc"], { url: "https://pc/new", environmentId: "pc" }],
    ["keeps a connected choice", pc, "laptop", { url: "https://laptop/v" }, ["pc", "laptop"], pc],
    ["replaces a disconnected choice", pc, "laptop", { url: "https://laptop/v" }, ["laptop"], { url: "https://laptop/v", environmentId: "laptop" }],
    ["drops it when its environment stops offering it", pc, "pc", { url: null }, ["pc"], null],
    ["ignores another environment without one", pc, "laptop", { url: null }, ["pc", "laptop"], pc],
    ["keeps it when the lookup failed", pc, "pc", "unknown", ["pc"], pc],
  ])("%s", (_name, current, environmentId, answer, connected, expected) => {
    expect(chooseVoiceServer(current, environmentId, answer, connected)).toEqual(expected);
  });
});
