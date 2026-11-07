import { normalizeMessageAuthor } from "@t3tools/client-runtime/user-message";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useMemo, useSyncExternalStore } from "react";
import { AsyncResult } from "effect/reactivity";

import { scopedThreadKey } from "../../lib/scopedEntities";
import type { Preferences } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";

const RETRY_DELAY_MS = 60_000;
const PROBE_CONCURRENCY = 4;

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

/** One author's shelf, the shared shelf, or null for threads nobody on the team named. */
export function threadAuthorShelf(authors: ReadonlyArray<string> | undefined): string | null {
  if (authors === undefined || authors.length === 0) return null;
  return authors.length === 1 ? authorShelfKey(authors[0]!) : TOGETHER_AUTHOR_SHELF;
}

/** Matches both "[Message from X]" and "[Voice message from X]" in the thread's own find. */
export const authorProbeQuery = (name: string) => `message from ${name}]`;

interface ThreadAuthorsEntry {
  readonly stamp: string;
  /** Lowercased names of the people who wrote in the thread. */
  readonly authors: ReadonlyArray<string>;
}

interface ThreadAuthorIndexOptions {
  /** Whether `name` wrote in the thread; rejects when the thread cannot be searched. */
  readonly wrote: (thread: EnvironmentThreadShell, name: string) => Promise<boolean>;
  readonly canProbe: (thread: EnvironmentThreadShell) => boolean;
  readonly retryDelayMs?: number;
}

/**
 * Remembers who wrote in each thread, asking the server again only when a thread gets a new user
 * message or the team changes. A thread keeps its last known authors while it is asked again,
 * so it does not jump out of its shelf for the length of a probe.
 */
export function createThreadAuthorIndex(options: ThreadAuthorIndexOptions) {
  let entries = new Map<string, ThreadAuthorsEntry>();
  const listeners = new Set<() => void>();
  const inFlight = new Set<string>();
  const failed = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const queue: Array<() => Promise<void>> = [];
  let running = 0;

  const pump = () => {
    while (running < PROBE_CONCURRENCY && queue.length > 0) {
      const task = queue.shift()!;
      running += 1;
      void task().finally(() => {
        running -= 1;
        pump();
      });
    }
  };

  const probe = (thread: EnvironmentThreadShell, people: ReadonlyArray<string>, stamp: string) => {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    const attempt = `${key}\n${stamp}`;
    queue.push(async () => {
      try {
        const wrote = await Promise.all(people.map((name) => options.wrote(thread, name)));
        const authors = people.filter((_, index) => wrote[index]).map((name) => name.toLowerCase());
        entries = new Map(entries).set(key, { stamp, authors });
        for (const listener of listeners) listener();
      } catch {
        failed.add(attempt);
        const timer = setTimeout(() => {
          timers.delete(timer);
          failed.delete(attempt);
        }, options.retryDelayMs ?? RETRY_DELAY_MS);
        timers.add(timer);
      } finally {
        inFlight.delete(attempt);
      }
    });
    inFlight.add(attempt);
    pump();
  };

  return {
    sweep(threads: ReadonlyArray<EnvironmentThreadShell>, people: ReadonlyArray<string>) {
      if (people.length === 0) return;
      const team = people.join("\n").toLowerCase();
      for (const thread of threads) {
        if (
          thread.archivedAt !== null ||
          thread.settledOverride === "settled" ||
          thread.latestUserMessageAt == null ||
          !options.canProbe(thread)
        ) {
          continue;
        }
        const stamp = `${thread.latestUserMessageAt}\n${team}`;
        const key = scopedThreadKey(thread.environmentId, thread.id);
        const attempt = `${key}\n${stamp}`;
        if (entries.get(key)?.stamp === stamp || inFlight.has(attempt) || failed.has(attempt)) {
          continue;
        }
        probe(thread, people, stamp);
      }
    },
    authorsOf(
      thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
    ): ReadonlyArray<string> | undefined {
      return entries.get(scopedThreadKey(thread.environmentId, thread.id))?.authors;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => entries,
    dispose() {
      queue.length = 0;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

function currentPeople(): string[] {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) ? resolveTeamPeople(preferences.value) : [];
}

export const threadAuthorIndex = createThreadAuthorIndex({
  canProbe: (thread) => appAtomRegistry.get(environmentServerConfigsAtom).has(thread.environmentId),
  wrote: async (thread, name) => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      orchestrationEnvironment.threadFind({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, query: authorProbeQuery(name) },
      }),
      { label: "thread-author-probe", reportFailure: false, reportDefect: true },
    );
    if (result._tag !== "Success") throw new Error("Thread author probe failed.");
    return result.value.totalMatches > 0;
  },
});

export function installThreadAuthorProbe(): () => void {
  const sweep = () =>
    threadAuthorIndex.sweep(
      appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
      currentPeople(),
    );
  const unsubscribeThreads = appAtomRegistry.subscribe(
    environmentThreadShells.threadShellsAtom,
    sweep,
    { immediate: true },
  );
  const unsubscribePreferences = appAtomRegistry.subscribe(mobilePreferencesAtom, sweep);
  return () => {
    unsubscribeThreads();
    unsubscribePreferences();
    threadAuthorIndex.dispose();
  };
}

/** Which author shelf a thread belongs in; a new function whenever any thread's authors change. */
export function useThreadAuthorShelfOf() {
  const entries = useSyncExternalStore(threadAuthorIndex.subscribe, threadAuthorIndex.getSnapshot);
  return useMemo(
    () => (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
      threadAuthorShelf(entries.get(scopedThreadKey(thread.environmentId, thread.id))?.authors),
    [entries],
  );
}
