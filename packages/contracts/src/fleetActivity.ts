import * as Schema from "effect/Schema";

/**
 * Work a thread has running on the fleet (gils-studio/fleet: the home laptops and test phones).
 * The agent session itself always runs on this server's machine; its heavy work (builds, test
 * suites, phone tests) runs elsewhere, and the clients show where (gils-studio/t3code#91).
 */
export const FleetActivityEntry = Schema.Struct({
  /** A detached job, a foreground `fleet run`, or a leased node or phone. */
  kind: Schema.Literals(["job", "run", "lease"]),
  /** Node or phone name, e.g. "pop-os" or "phone-1". */
  where: Schema.String,
  whereKind: Schema.Literals(["node", "phone"]),
  /** Job name, command start or lease note. */
  label: Schema.optional(Schema.String),
  /** Epoch milliseconds. */
  since: Schema.optional(Schema.Number),
});
export type FleetActivityEntry = typeof FleetActivityEntry.Type;

/** Everything running on the fleet right now, by thread id; threads without fleet work are absent. */
export const FleetActivitySnapshot = Schema.Struct({
  threads: Schema.Record(Schema.String, Schema.Array(FleetActivityEntry)),
});
export type FleetActivitySnapshot = typeof FleetActivitySnapshot.Type;
