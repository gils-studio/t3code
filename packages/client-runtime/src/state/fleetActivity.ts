import { type FleetActivityEntry, WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

/**
 * Fleet work per thread (gils-studio/t3code#91): the session runs on the environment's machine,
 * its builds, test suites and phone tests run on fleet machines, and working threads name them.
 */
export function createFleetActivityAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
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
  /** Longer text for a tooltip or screen reader, e.g. "Running on pop-os: e2e (4 min), phone-1". */
  readonly description: string;
}

function minutes(since: number | undefined, now: number): string | undefined {
  if (since === undefined || since > now) return undefined;
  const m = Math.floor((now - since) / 60_000);
  return m < 1 ? "<1 min" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * One badge for a thread's fleet work, or null when it has none. Machines are named once each,
 * in the order the work started; work on a phone names the phone.
 */
export function fleetActivityBadge(
  entries: ReadonlyArray<FleetActivityEntry> | undefined,
  now = Date.now(),
): FleetActivityBadge | null {
  if (!entries || entries.length === 0) return null;
  const places: string[] = [];
  for (const entry of entries) if (!places.includes(entry.where)) places.push(entry.where);
  const text = places.length > 1 ? `${places[0]} +${places.length - 1}` : places[0]!;
  const parts = entries.map((entry) => {
    const detail = [entry.label, minutes(entry.since, now)].filter(Boolean).join(", ");
    return detail ? `${entry.where}: ${detail}` : entry.where;
  });
  return { text, description: `Running on ${parts.join("; ")}` };
}
