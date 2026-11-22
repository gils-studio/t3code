import { describe, expect, it } from "@effect/vitest";

import { parseFleetActivity } from "./FleetActivity.ts";

describe("parseFleetActivity", () => {
  it("groups fleet work by thread and drops rows without one", () => {
    const stdout = JSON.stringify([
      {
        kind: "job",
        id: "e2e-1a2b",
        where: "pop-os",
        whereKind: "node",
        label: "e2e",
        thread: "t-1",
        since: 5,
      },
      { kind: "lease", id: "phone:phone-1", where: "phone-1", whereKind: "phone", thread: "t-1" },
      { kind: "job", id: "gate-9f00", where: "laptop-gerrit", whereKind: "node", label: "gate" },
      {
        kind: "run",
        id: "4711",
        where: "laptop-gerrit",
        whereKind: "node",
        label: "npm test",
        thread: "t-2",
      },
    ]);
    expect(parseFleetActivity(stdout)).toEqual({
      threads: {
        "t-1": [
          { kind: "job", where: "pop-os", whereKind: "node", label: "e2e", since: 5 },
          { kind: "lease", where: "phone-1", whereKind: "phone" },
        ],
        "t-2": [{ kind: "run", where: "laptop-gerrit", whereKind: "node", label: "npm test" }],
      },
    });
  });

  it("treats anything but a JSON array as nothing running", () => {
    expect(parseFleetActivity("(nothing running)")).toEqual({ threads: {} });
    expect(parseFleetActivity('{"threads":{}}')).toEqual({ threads: {} });
  });

  it("ignores unknown kinds and caps what one thread shows", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      kind: "job",
      where: `n${i}`,
      thread: "t",
    }));
    rows.push({ kind: "weird", where: "x", thread: "u" });
    const parsed = parseFleetActivity(JSON.stringify(rows));
    expect(parsed.threads.t).toHaveLength(8);
    expect(parsed.threads.u).toBeUndefined();
  });
});
