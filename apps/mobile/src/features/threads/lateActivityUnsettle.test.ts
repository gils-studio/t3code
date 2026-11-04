import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/threads", () => ({ environmentThreadShells: {}, threadEnvironment: {} }));

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { createLateActivityUnsettler } from "./lateActivityUnsettle";

function lateThread(settledAt = "2026-11-04T20:00:00.000Z") {
  return {
    environmentId: "env",
    id: "thread",
    settledOverride: "settled",
    settledAt,
    archivedAt: null,
    latestRun: { requestedAt: null, startedAt: null, completedAt: "2026-11-04T21:00:00.000Z" },
    source: { latestVisibleMessage: null },
  } as unknown as EnvironmentThreadShell;
}

describe("createLateActivityUnsettler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("unsettles a late thread once however often the shells change", async () => {
    const unsettle = vi.fn(async () => true);
    const unsettler = createLateActivityUnsettler({ canUnsettle: () => true, unsettle });
    unsettler.sweep([lateThread()]);
    unsettler.sweep([lateThread()]);
    await vi.runAllTimersAsync();
    unsettler.sweep([lateThread()]);
    expect(unsettle).toHaveBeenCalledTimes(1);
  });

  it("retries a failed unsettle only after the delay", async () => {
    const unsettle = vi.fn(async () => false);
    const unsettler = createLateActivityUnsettler({
      canUnsettle: () => true,
      unsettle,
      retryDelayMs: 1_000,
    });
    unsettler.sweep([lateThread()]);
    await vi.advanceTimersByTimeAsync(500);
    unsettler.sweep([lateThread()]);
    expect(unsettle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    unsettler.sweep([lateThread()]);
    expect(unsettle).toHaveBeenCalledTimes(2);
    unsettler.dispose();
  });

  it("skips threads this connection cannot change", () => {
    const unsettle = vi.fn(async () => true);
    const unsettler = createLateActivityUnsettler({ canUnsettle: () => false, unsettle });
    unsettler.sweep([lateThread()]);
    expect(unsettle).not.toHaveBeenCalled();
  });
});
