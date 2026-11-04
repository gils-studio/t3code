import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { threadActiveAfterSettling } from "./threadSettled.ts";

const SETTLED_AT = "2026-11-04T20:00:00.000Z";
const LATER = "2026-11-04T20:10:00.000Z";

function thread(overrides: {
  readonly settledOverride?: "settled" | "active" | null;
  readonly settledAt?: string | null;
  readonly archivedAt?: string | null;
  readonly completedAt?: string | null;
  readonly messageAt?: string;
}): Parameters<typeof threadActiveAfterSettling>[0] {
  const message =
    overrides.messageAt === undefined
      ? null
      : ({ updatedAt: DateTime.makeUnsafe(overrides.messageAt) } as never);
  return {
    settledOverride:
      overrides.settledOverride === undefined ? "settled" : overrides.settledOverride,
    settledAt: overrides.settledAt === undefined ? SETTLED_AT : overrides.settledAt,
    archivedAt: overrides.archivedAt ?? null,
    latestRun: {
      runId: "run" as never,
      status: "completed",
      requestedAt: null,
      startedAt: null,
      completedAt: overrides.completedAt ?? SETTLED_AT,
      assistantMessageId: null,
    } as never,
    source: { latestVisibleMessage: message },
  };
}

describe("threadActiveAfterSettling", () => {
  it("stays quiet when the settled turn was the last activity", () => {
    expect(threadActiveAfterSettling(thread({ messageAt: SETTLED_AT }))).toBe(false);
  });

  it("ignores output trailing the settlement by a moment", () => {
    expect(threadActiveAfterSettling(thread({ messageAt: "2026-11-04T20:00:02.000Z" }))).toBe(
      false,
    );
  });

  it("sees a message that arrived after settling", () => {
    expect(threadActiveAfterSettling(thread({ messageAt: LATER }))).toBe(true);
  });

  it("sees a run that finished after settling", () => {
    expect(threadActiveAfterSettling(thread({ completedAt: LATER }))).toBe(true);
  });

  it("leaves active and archived threads alone", () => {
    expect(threadActiveAfterSettling(thread({ settledOverride: null, messageAt: LATER }))).toBe(
      false,
    );
    expect(threadActiveAfterSettling(thread({ settledOverride: "active", messageAt: LATER }))).toBe(
      false,
    );
    expect(threadActiveAfterSettling(thread({ archivedAt: LATER, messageAt: LATER }))).toBe(false);
  });
});
