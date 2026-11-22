import { describe, expect, it } from "@effect/vitest";

import { fleetActivityBadge } from "./fleetActivity.ts";

describe("fleetActivityBadge", () => {
  it("is absent without fleet work", () => {
    expect(fleetActivityBadge(undefined)).toBeNull();
    expect(fleetActivityBadge([])).toBeNull();
  });

  it("names the machine, and counts further machines", () => {
    expect(
      fleetActivityBadge([
        { kind: "job", where: "pop-os", whereKind: "node", label: "e2e", since: 1 },
        { kind: "job", where: "pop-os", whereKind: "node", label: "apk" },
        { kind: "lease", where: "phone-1", whereKind: "phone" },
      ]),
    ).toEqual({
      text: "pop-os +1",
      description: "Running on pop-os: e2e; pop-os: apk; phone-1",
    });
  });

  it("shows one machine alone", () => {
    expect(
      fleetActivityBadge([{ kind: "run", where: "laptop-gerrit", whereKind: "node" }])?.text,
    ).toBe("laptop-gerrit");
  });
});
