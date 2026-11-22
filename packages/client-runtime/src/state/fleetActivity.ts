import { type FleetActivityEntry, WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

/**
 * Fleet work per thread (gils-studio/t3code#91): the session runs on the environment's machine,
 * its builds, test suites and phone tests run on fleet machines, and working threads name them.
 */
export function createFleetActivityAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:fleet-activity",
      tag: WS_METHODS.subscribeFleetActivity,
      // Rows subscribe only while their thread works; keep the stream across short gaps.
      idleTtlMs: 60_000,
    }),
  };
}

export interface FleetActivityBadge {
  /** Short text for the badge, e.g. "pop-os" or "pop-os +1". */
  readonly text: string;
  /** Longer text for a tooltip or screen reader, e.g. "Running on pop-os: e2e; phone-1". */
  readonly description: string;
}

/**
 * One badge for a thread's fleet work, or null when it has none. Machines are named once each,
 * in the order the work started; work on a phone names the phone.
 */
export function fleetActivityBadge(
  entries: ReadonlyArray<FleetActivityEntry> | undefined,
): FleetActivityBadge | null {
  if (!entries || entries.length === 0) return null;
  const places: string[] = [];
  for (const entry of entries) if (!places.includes(entry.where)) places.push(entry.where);
  const text = places.length > 1 ? `${places[0]} +${places.length - 1}` : places[0]!;
  const parts = entries.map((entry) =>
    entry.label ? `${entry.where}: ${entry.label}` : entry.where,
  );
  return { text, description: `Running on ${parts.join("; ")}` };
}
