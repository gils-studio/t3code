import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));

import {
  authorShelfKey,
  parseTeamMemberNames,
  resolveTeamPeople,
  threadAuthorShelf,
  TOGETHER_AUTHOR_SHELF,
} from "./messageAuthors";

describe("team people", () => {
  it("reads names once each, this device's own first", () => {
    expect(parseTeamMemberNames(" Nils, ,nils,Ann]a ")).toEqual(["Nils", "Anna"]);
    expect(
      resolveTeamPeople({ messageAuthorName: "Gerrit", teamMemberNames: ["gerrit", "Nils"] }),
    ).toEqual(["Gerrit", "Nils"]);
  });

  it("puts a thread on its only team author's shelf, or the shared one", () => {
    const team = ["Gerrit", "Nils"];
    expect(threadAuthorShelf(undefined, team)).toBeNull();
    expect(threadAuthorShelf([], team)).toBeNull();
    expect(threadAuthorShelf(["Anna"], team)).toBeNull();
    expect(threadAuthorShelf(["nils", "Anna"], team)).toBe(authorShelfKey("Nils"));
    expect(threadAuthorShelf(["Gerrit", "NILS"], team)).toBe(TOGETHER_AUTHOR_SHELF);
  });
});
