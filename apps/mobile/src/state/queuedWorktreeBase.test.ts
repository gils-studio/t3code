import { EnvironmentId, ProjectId, type VcsListRefsResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveQueuedWorktreeBase } from "./queuedWorktreeBase";
import type { QueuedThreadCreation } from "./thread-outbox-model";

const environmentId = EnvironmentId.make("environment");
const offlineWorktree: QueuedThreadCreation = {
  projectId: ProjectId.make("project"),
  workspaceMode: "worktree",
  branch: null,
  worktreePath: null,
};
const ref = (name: string, flags: { current?: boolean; isDefault?: boolean; isRemote?: boolean }) => ({
  name,
  current: flags.current ?? false,
  isDefault: flags.isDefault ?? false,
  ...(flags.isRemote ? { isRemote: true } : {}),
  worktreePath: null,
});
const listing = (
  refs: VcsListRefsResult["refs"],
  isRepo = true,
): VcsListRefsResult => ({
  refs,
  isRepo,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: refs.length,
});

function resolve(creation: QueuedThreadCreation, result: VcsListRefsResult) {
  const readRefs = vi.fn(async () => AsyncResult.success(result));
  return {
    readRefs,
    resolved: resolveQueuedWorktreeBase({ creation, environmentId, projectCwd: "/repo", readRefs }),
  };
}

describe("resolveQueuedWorktreeBase", () => {
  it.each([
    {
      name: "starts an offline worktree task from the default branch",
      refs: listing([ref("feature", { current: true }), ref("main", { isDefault: true })]),
      expected: { ...offlineWorktree, branch: "main" },
    },
    {
      name: "falls back to the current branch without a default",
      refs: listing([ref("origin/feature", { isRemote: true }), ref("feature", { current: true })]),
      expected: { ...offlineWorktree, branch: "feature" },
    },
    {
      name: "runs in the checkout when the project is no repository",
      refs: listing([], false),
      expected: { ...offlineWorktree, workspaceMode: "local" },
    },
    {
      name: "gives up when the repository has no branch to start from",
      refs: listing([]),
      expected: null,
    },
  ])("$name", async ({ refs, expected }) => {
    const { resolved, readRefs } = resolve(offlineWorktree, refs);
    expect(await resolved).toEqual(AsyncResult.success(expected));
    expect(readRefs).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", refresh: true },
    });
  });

  it("leaves a chosen base and pull request checkouts alone", async () => {
    for (const creation of [
      { ...offlineWorktree, branch: "release" },
      { ...offlineWorktree, pullRequestReference: "https://github.com/acme/repo/pull/1" },
      { ...offlineWorktree, workspaceMode: "local" as const },
    ]) {
      const { resolved, readRefs } = resolve(creation, listing([]));
      expect(await resolved).toEqual(AsyncResult.success(creation));
      expect(readRefs).not.toHaveBeenCalled();
    }
  });
});
