import { describe, expect, it } from "vite-plus/test";

import { isPendingRequestHeldBack } from "./pendingRequestHold";

const base = {
  requestId: "request-1",
  openedRequestId: null,
  dictatingHere: false,
  draftHasMessage: false,
};

describe("isPendingRequestHeldBack", () => {
  it.each([
    ["no question", { requestId: null, dictatingHere: true }, false],
    ["idle composer", {}, false],
    ["dictating here", { dictatingHere: true }, true],
    ["unsent draft", { draftHasMessage: true }, true],
    ["opened over a draft", { openedRequestId: "request-1", draftHasMessage: true }, false],
    ["opened during a dictation", { openedRequestId: "request-1", dictatingHere: true }, true],
    [
      "a newer question after opening an older one",
      { openedRequestId: "request-0", draftHasMessage: true },
      true,
    ],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(isPendingRequestHeldBack({ ...base, ...overrides })).toBe(expected);
  });
});
