import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadActiveAfterSettling } from "@t3tools/client-runtime/state/threadSettled";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";

const RETRY_DELAY_MS = 60_000;

interface LateActivityUnsettlerOptions {
  readonly canUnsettle: (thread: EnvironmentThreadShell) => boolean;
  readonly unsettle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly retryDelayMs?: number;
}

/**
 * Brings settled threads back when they report new activity. Each settlement is tried once:
 * re-settling a thread writes a new settledAt, so the user's decision sticks. A failure retries
 * after a delay rather than on the next shell change, because its rollback is a shell change too.
 */
export function createLateActivityUnsettler(options: LateActivityUnsettlerOptions) {
  const attempted = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const retryLater = (attempt: string) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      attempted.delete(attempt);
    }, options.retryDelayMs ?? RETRY_DELAY_MS);
    timers.add(timer);
  };

  return {
    sweep(threads: ReadonlyArray<EnvironmentThreadShell>) {
      for (const thread of threads) {
        if (!threadActiveAfterSettling(thread) || !options.canUnsettle(thread)) continue;
        const attempt = `${scopedThreadKey(thread.environmentId, thread.id)}:${thread.settledAt}`;
        if (attempted.has(attempt)) continue;
        attempted.add(attempt);
        void options.unsettle(thread).then((succeeded) => {
          if (!succeeded) retryLater(attempt);
        });
      }
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

export function installLateActivityUnsettle(): () => void {
  const unsettler = createLateActivityUnsettler({
    canUnsettle: (thread) =>
      appAtomRegistry.get(environmentServerConfigsAtom).has(thread.environmentId) &&
      readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
    unsettle: async (thread) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.unsettle,
        // The only reason the server takes; the next real activity clears its active pin.
        { environmentId: thread.environmentId, input: { threadId: thread.id, reason: "user" } },
        { label: "late-activity-unsettle", reportFailure: false, reportDefect: true },
      );
      return result._tag === "Success";
    },
  });
  const unsubscribe = appAtomRegistry.subscribe(
    environmentThreadShells.threadShellsAtom,
    unsettler.sweep,
    { immediate: true },
  );
  return () => {
    unsubscribe();
    unsettler.dispose();
  };
}
