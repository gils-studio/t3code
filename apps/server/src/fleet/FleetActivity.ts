// @effect-diagnostics nodeBuiltinImport:off -- the fleet controller lives in the user's home, which Effect's Path does not expose.
import * as NodeOS from "node:os";

import type { FleetActivityEntry, FleetActivitySnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";

/**
 * Fleet work by thread from `fleet activity --json` (gils-studio/t3code#91), asked only while a
 * client listens. Without the fleet controller (`~/.fleet/app`) the snapshot stays empty.
 */
export class FleetActivity extends Context.Service<
  FleetActivity,
  {
    /** The current snapshot, then every change; polls while at least one stream is open. */
    readonly stream: Stream.Stream<FleetActivitySnapshot>;
  }
>()("t3/fleet/FleetActivity") {}

const EMPTY: FleetActivitySnapshot = { threads: {} };
/** While a client listens, a change shows within this time. */
const POLL_INTERVAL = Duration.seconds(10);
const MAX_ENTRIES_PER_THREAD = 8;


const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined;

/** `fleet activity --json` output -> snapshot. Rows without a thread (staging gate, cron) are dropped. */
export function parseFleetActivity(stdout: string): FleetActivitySnapshot {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return EMPTY;
  }
  if (!Array.isArray(rows)) return EMPTY;
  const threads: Record<string, FleetActivityEntry[]> = {};
  for (const row of rows as ReadonlyArray<Record<string, unknown>>) {
    const thread = text(row?.thread, 128);
    const where = text(row?.where, 64);
    const kind = row?.kind;
    if (!thread || !where || (kind !== "job" && kind !== "run" && kind !== "lease")) continue;
    const label = text(row.label, 60);
    const since = typeof row.since === "number" && Number.isFinite(row.since) ? row.since : undefined;
    const entry: FleetActivityEntry = {
      kind,
      where,
      whereKind: row.whereKind === "phone" ? "phone" : "node",
      ...(label === undefined ? {} : { label }),
      ...(since === undefined ? {} : { since }),
    };
    const list = (threads[thread] ??= []);
    if (list.length < MAX_ENTRIES_PER_THREAD) list.push(entry);
  }
  return { threads };
}

const sameSnapshot = (a: FleetActivitySnapshot, b: FleetActivitySnapshot) =>
  JSON.stringify(a) === JSON.stringify(b);

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const snapshotRef = yield* SubscriptionRef.make<FleetActivitySnapshot>(EMPTY);
  const listeners = yield* Ref.make(0);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cli =
    process.env.T3CODE_FLEET_CLI ?? path.join(NodeOS.homedir(), ".fleet", "app", "src", "cli.ts");

  const poll = Effect.gen(function* () {
    if (!(yield* fs.exists(cli))) return;
    const result = yield* runner.run({
      command: "node",
      args: ["--no-warnings", cli, "activity", "--json"],
      timeout: Duration.seconds(20),
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 256 * 1024,
      outputMode: "truncate",
    });
    if (result.timedOut || result.code !== 0) return;
    const next = parseFleetActivity(result.stdout);
    const current = yield* SubscriptionRef.get(snapshotRef);
    if (!sameSnapshot(current, next)) yield* SubscriptionRef.set(snapshotRef, next);
  }).pipe(
    Effect.catchCause((cause) => Effect.logDebug("fleet activity poll failed", cause)),
  );

  // Without listeners nothing is asked; the next first listener polls at once.
  const loop: Effect.Effect<never> = Effect.gen(function* () {
    if ((yield* Ref.get(listeners)) > 0) yield* poll;
    yield* Effect.sleep(POLL_INTERVAL);
  }).pipe(Effect.forever);
  yield* forkParked(loop);

  const stream = Stream.unwrap(
    Effect.gen(function* () {
      const first = yield* Ref.getAndUpdate(listeners, (n) => n + 1);
      yield* Effect.addFinalizer(() => Ref.update(listeners, (n) => Math.max(0, n - 1)));
      // The first listener should not wait for the next tick.
      if (first === 0) yield* poll;
      return SubscriptionRef.changes(snapshotRef);
    }),
  ).pipe(Stream.scoped);

  return FleetActivity.of({ stream });
});

export const layer = Layer.effect(FleetActivity, make);
