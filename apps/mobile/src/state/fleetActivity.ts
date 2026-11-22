import {
  createFleetActivityAtoms,
  fleetActivityBadge,
  type FleetActivityBadge,
} from "@t3tools/client-runtime/state/fleetActivity";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const fleetActivity = createFleetActivityAtoms(connectionAtomRuntime);

/**
 * The fleet machine a working thread's builds and tests run on (gils-studio/t3code#91). Pass a
 * null environment while the thread does not work: then nothing is subscribed.
 */
export function useThreadFleetBadge(
  environmentId: EnvironmentId | null,
  threadId: string,
): FleetActivityBadge | null {
  const query = useEnvironmentQuery(
    environmentId === null ? null : fleetActivity.snapshot({ environmentId, input: {} }),
  );
  return fleetActivityBadge(query.data?.threads[threadId]);
}
