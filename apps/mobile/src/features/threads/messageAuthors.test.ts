import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/threads", () => ({ environmentThreadShells: {} }));

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  authorShelfKey,
  createThreadAuthorIndex,
  parseTeamMemberNames,
  resolveTeamPeople,
  threadAuthorShelf,
  TOGETHER_AUTHOR_SHELF,
} from "./messageAuthors";

function thread(id: string, latestUserMessageAt: string | null = "2026-11-08T10:00:00.000Z") {
  return {
    environmentId: "env",
    id,
    archivedAt: null,
    settledOverride: null,
    latestUserMessageAt,
  } as unknown as EnvironmentThreadShell;
}

describe("team people", () => {
  it("reads names once each, this device's own first", () => {
    expect(parseTeamMemberNames(" Nils, ,nils,Ann]a ")).toEqual(["Nils", "Anna"]);
    expect(
      resolveTeamPeople({ messageAuthorName: "Gerrit", teamMemberNames: ["gerrit", "Nils"] }),
    ).toEqual(["Gerrit", "Nils"]);
  });

  it("puts a thread on its only author's shelf, or the shared one", () => {
    expect(threadAuthorShelf(undefined)).toBeNull();
    expect(threadAuthorShelf([])).toBeNull();
    expect(threadAuthorShelf(["nils"])).toBe(authorShelfKey("Nils"));
    expect(threadAuthorShelf(["gerrit", "nils"])).toBe(TOGETHER_AUTHOR_SHELF);
  });
});

describe("createThreadAuthorIndex", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks again only when a thread gets a new message or the team changes", async () => {
    const wrote = vi.fn(async (_thread: EnvironmentThreadShell, name: string) => name === "Nils");
    const index = createThreadAuthorIndex({ wrote, canProbe: () => true });
    index.sweep([thread("a"), thread("b", null)], ["Gerrit", "Nils"]);
    index.sweep([thread("a")], ["Gerrit", "Nils"]);
    await vi.runAllTimersAsync();
    expect(index.authorsOf(thread("a"))).toEqual(["nils"]);
    expect(index.authorsOf(thread("b"))).toBeUndefined();
    expect(wrote).toHaveBeenCalledTimes(2);

    index.sweep([thread("a")], ["Gerrit", "Nils"]);
    expect(wrote).toHaveBeenCalledTimes(2);
    wrote.mockImplementation(async () => true);
    index.sweep([thread("a", "2026-11-08T11:00:00.000Z")], ["Gerrit", "Nils"]);
    // The old authors hold while the thread is asked again.
    expect(index.authorsOf(thread("a"))).toEqual(["nils"]);
    await vi.runAllTimersAsync();
    expect(index.authorsOf(thread("a"))).toEqual(["gerrit", "nils"]);
    index.sweep([thread("a", "2026-11-08T11:00:00.000Z")], ["Gerrit"]);
    await vi.runAllTimersAsync();
    expect(index.authorsOf(thread("a"))).toEqual(["gerrit"]);
  });

  it("retries a thread it could not search only after the delay", async () => {
    const wrote = vi.fn(async () => {
      throw new Error("offline");
    });
    const index = createThreadAuthorIndex({ wrote, canProbe: () => true, retryDelayMs: 1_000 });
    index.sweep([thread("a")], ["Gerrit"]);
    await vi.advanceTimersByTimeAsync(500);
    index.sweep([thread("a")], ["Gerrit"]);
    expect(wrote).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    index.sweep([thread("a")], ["Gerrit"]);
    expect(wrote).toHaveBeenCalledTimes(2);
    index.dispose();
  });
});
