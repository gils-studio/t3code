import { describe, expect, it } from "@effect/vitest";

import { isEveningLocked, isEveningLockedPerson, nextEveningLockBoundary } from "./eveningLock";

// November 2026: the 8th is a Sunday, the 13th a Friday.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

describe("isEveningLocked", () => {
  it.each([
    ["Sunday 19:59", at(8, 19, 59), false],
    ["Sunday 20:00", at(8, 20), true],
    ["Monday 05:59", at(9, 5, 59), true],
    ["Monday 06:00", at(9, 6), false],
    ["Monday 23:30", at(9, 23, 30), true],
    ["Thursday 22:00", at(12, 22), true],
    ["Friday 03:00", at(13, 3), true],
    ["Friday 21:00", at(13, 21), false],
    ["Saturday 02:00", at(14, 2), false],
    ["Saturday 21:00", at(14, 21), false],
    ["Sunday 03:00", at(15, 3), false],
  ])("%s", (_label, now, locked) => {
    expect(isEveningLocked(now)).toBe(locked);
  });
});

describe("nextEveningLockBoundary", () => {
  it.each([
    [at(9, 3, 15), at(9, 6)],
    [at(9, 12, 40), at(9, 20)],
    [at(9, 21, 5), at(10, 6)],
    [at(30, 22), new Date(2026, 11, 1, 6)],
  ])("%s", (now, next) => {
    expect(nextEveningLockBoundary(now)).toEqual(next);
  });
});

describe("isEveningLockedPerson", () => {
  it.each([
    ["Gerrit", true],
    [" gerrit ", true],
    ["Nils", false],
    [undefined, false],
  ])("%s", (author, locked) => {
    expect(isEveningLockedPerson(author)).toBe(locked);
  });
});
