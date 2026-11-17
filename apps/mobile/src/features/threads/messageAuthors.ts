import { useAtomValue } from "@effect/atom-react";
import { normalizeMessageAuthor } from "@t3tools/client-runtime/user-message";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import type { Preferences } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom } from "../../state/preferences";

export const TOGETHER_AUTHOR_SHELF = "together";

/** Splits "Nils, Anna" into names, dropping blanks and repeats. */
export function parseTeamMemberNames(text: string): string[] {
  return dedupeNames(text.split(","));
}

function dedupeNames(names: ReadonlyArray<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const name = normalizeMessageAuthor(raw);
    if (name === undefined || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    result.push(name);
  }
  return result;
}

/** Everyone the list groups by: this device's name first, then the rest of the team. */
export function resolveTeamPeople(
  preferences: Pick<Preferences, "messageAuthorName" | "teamMemberNames">,
): string[] {
  return dedupeNames([preferences.messageAuthorName, ...(preferences.teamMemberNames ?? [])]);
}

export const authorShelfKey = (name: string) => `person:${name.toLowerCase()}`;

/** The only team member who wrote in a thread, the shared shelf, or null when none of them did. */
export function threadAuthorShelf(
  authors: ReadonlyArray<string> | undefined,
  people: ReadonlyArray<string>,
): string | null {
  const team = new Set(people.map((name) => name.toLowerCase()));
  const wrote = new Set(
    (authors ?? []).map((name) => name.toLowerCase()).filter((name) => team.has(name)),
  );
  const [only] = wrote;
  if (only === undefined) return null;
  return wrote.size === 1 ? authorShelfKey(only) : TOGETHER_AUTHOR_SHELF;
}

/** Which author shelf a thread belongs in, from the authors its shell carries. */
export function useThreadAuthorShelfOf() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const people = AsyncResult.isSuccess(preferences)
    ? resolveTeamPeople(preferences.value).join("\n")
    : "";
  return useMemo(() => {
    const names = people === "" ? [] : people.split("\n");
    return (thread: Pick<EnvironmentThreadShell, "messageAuthors">) =>
      threadAuthorShelf(thread.messageAuthors, names);
  }, [people]);
}
