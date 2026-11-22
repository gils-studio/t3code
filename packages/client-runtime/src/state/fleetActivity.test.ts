import { describe, expect, it } from "@effect/vitest";

import { fleetActivityBadge } from "./fleetActivity.ts";

describe("fleetActivityBadge", () => {
  const now = 10 * 60_000;

  it("is absent without fleet work", () => {
    expect(fleetActivityBadge(undefined, now)).toBeNull();
    expect(fleetActivityBadge([], now)).toBeNull();
  });

  it("names the machine, and counts further machines", () => {
    expect(
      fleetActivityBadge(
        [
          { kind: "job", where: "pop-os", whereKind: "node", label: "e2e", since: now - 4 * 60_000 },
          { kind: "job", where: "pop-os", whereKind: "node", label: "apk" },
          { kind: "lease", where: "phone-1", whereKind: "phone" },
        ],
        now,
      ),
    ).toEqual({
      text: "pop-os +1",
      description: "Running on pop-os: e2e, 4 min; pop-os: apk; phone-1",
    });
  });

  it("shows one machine alone", () => {
    expect(
      fleetActivityBadge([{ kind: "run", where: "laptop-gerrit", whereKind: "node" }], now)?.text,
    ).toBe("laptop-gerrit");
  });
});
