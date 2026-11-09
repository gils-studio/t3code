import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, VcsListRefsInput, VcsListRefsResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { defaultWorktreeBase } from "../features/threads/new-task-context-presentation";
import type { QueuedThreadCreation } from "./thread-outbox-model";

/**
 * A worktree task queued offline had no refs to choose a base from, so it gets
 * the one the new-task picker would have filled in, read when it leaves.
 * Null when the repository has no branch to start from.
 */
export async function resolveQueuedWorktreeBase<E>(input: {
  readonly creation: QueuedThreadCreation;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string;
  readonly readRefs: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: VcsListRefsInput;
  }) => Promise<AtomCommandResult<VcsListRefsResult, E>>;
}): Promise<AtomCommandResult<QueuedThreadCreation | null, E>> {
  const { creation } = input;
  if (
    creation.workspaceMode !== "worktree" ||
    creation.branch !== null ||
    creation.pullRequestReference
  ) {
    return AsyncResult.success(creation);
  }
  const refs = await input.readRefs({
    environmentId: input.environmentId,
    input: { cwd: input.projectCwd, refresh: true },
  });
  return mapAtomCommandResult(refs, (result): QueuedThreadCreation | null => {
    if (!result.isRepo) return { ...creation, workspaceMode: "local", worktreePath: null };
    const base = defaultWorktreeBase(result.refs);
    return base === null ? null : { ...creation, branch: base };
  });
}
