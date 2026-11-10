import { normalizeMessageAuthor } from "@t3tools/client-runtime/user-message";

/** Gerrit asked to be kept out of the app on evenings before a workday. */
const LOCKED_PERSON = "gerrit";
const LOCK_FROM_HOUR = 20;
const LOCK_UNTIL_HOUR = 6;
/** Evenings (Date#getDay) that start a lock: Sunday through Thursday. */
const LOCKED_EVENINGS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4]);

export const EVENING_LOCK_UNTIL_LABEL = `${LOCK_UNTIL_HOUR}:00`;

export function isEveningLockedPerson(author: string | null | undefined): boolean {
  return normalizeMessageAuthor(author)?.toLowerCase() === LOCKED_PERSON;
}

/** Whether the device's local time falls inside a lock. */
export function isEveningLocked(now: Date): boolean {
  const hour = now.getHours();
  if (hour >= LOCK_FROM_HOUR) return LOCKED_EVENINGS.has(now.getDay());
  if (hour < LOCK_UNTIL_HOUR) return LOCKED_EVENINGS.has((now.getDay() + 6) % 7);
  return false;
}

/** The next local hour at which a lock could start or end. */
export function nextEveningLockBoundary(now: Date): Date {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  const hour = now.getHours();
  if (hour < LOCK_UNTIL_HOUR) next.setHours(LOCK_UNTIL_HOUR);
  else if (hour < LOCK_FROM_HOUR) next.setHours(LOCK_FROM_HOUR);
  else {
    next.setDate(next.getDate() + 1);
    next.setHours(LOCK_UNTIL_HOUR);
  }
  return next;
}
