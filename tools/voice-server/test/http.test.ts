import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { createHttpServer } from "../src/httpServer.ts";
import { JobStore } from "../src/jobStore.ts";

const token = "device-token";
const namedToken = "named-device-token";
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-http-"));
const store = new JobStore(root);
await store.load();
let created = 0;
let warmed = 0;
const liveChunks = new Map<string, string>();
const endedLive: string[] = [];
const server = createHttpServer({
  store,
  tokenHashes: () => [sha256(token), sha256(namedToken)],
  speakers: () => ({ [sha256(namedToken)]: "Nils" }),
  environmentId: "env-1",
  onJobCreated: () => (created += 1),
  warm: () => (warmed += 1),
  live: {
    append: async (id, offset, bytes) => {
      const current = liveChunks.get(id) ?? "";
      if (offset !== current.length) {
        return { accepted: false, received: current.length, text: "" };
      }
      const next = current + Buffer.from(bytes).toString("utf8");
      liveChunks.set(id, next);
      return { accepted: true, received: next.length, text: `heard ${next}` };
    },
    end: async (id) => void endedLive.push(id),
  },
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
NodeTest.after(() => server.close());

const auth = { authorization: `Bearer ${token}` };
const body = (audio: string, meta: object = { mode: "send", threadId: "t", language: "de" }) =>
  `${JSON.stringify(meta)}\n${audio}`;

NodeTest.test(
  "names the speaker the phone set, else the one its token was paired with",
  async () => {
    const upload = (id: string, secret: string, meta: object) =>
      fetch(`${base}/v1/jobs/${id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${secret}` },
        body: body("audio", meta),
      });
    const meta = { mode: "send", threadId: "t", language: "de" };
    const cases = [
      ["speaker-phone", namedToken, { ...meta, speaker: " Gerrit " }, "Gerrit"],
      ["speaker-token", namedToken, meta, "Nils"],
      ["speaker-bad-name", namedToken, { ...meta, speaker: "Ger]rit" }, "Nils"],
      ["speaker-unnamed", token, meta, undefined],
    ] as const;
    for (const [id, secret, sent, expected] of cases) {
      const response = await upload(id, secret, sent);
      NodeAssert.equal(((await response.json()) as { speaker: unknown }).speaker, expected ?? null);
      NodeAssert.equal(store.get(id)?.speaker, expected);
    }
    await Promise.all(cases.map(([id]) => store.remove(id)));
  },
);

NodeTest.test("rejects requests without a valid token", async () => {
  NodeAssert.equal((await fetch(`${base}/v1/info`)).status, 401);
  const wrong = await fetch(`${base}/v1/info`, { headers: { authorization: "Bearer nope" } });
  NodeAssert.equal(wrong.status, 401);
  const upload = await fetch(`${base}/v1/jobs/job-00001`, { method: "PUT", body: body("a") });
  NodeAssert.equal(upload.status, 401);
  NodeAssert.equal(store.get("job-00001"), undefined);
});

NodeTest.test("reports the environment it belongs to", async () => {
  const response = await fetch(`${base}/v1/info`, { headers: auth });
  NodeAssert.deepEqual(await response.json(), { environmentId: "env-1" });
});

NodeTest.test(
  "stores the audio before acknowledging and accepts a repeated upload once",
  async () => {
    const first = await fetch(`${base}/v1/jobs/job-00002`, {
      method: "PUT",
      headers: auth,
      body: body("audio-bytes"),
    });
    NodeAssert.equal(first.status, 201);
    NodeAssert.equal(await NodeFSP.readFile(store.audioPath("job-00002"), "utf8"), "audio-bytes");

    const before = created;
    const repeated = await fetch(`${base}/v1/jobs/job-00002`, {
      method: "PUT",
      headers: auth,
      body: body("other"),
    });
    NodeAssert.equal(repeated.status, 200);
    NodeAssert.equal(created, before);
    NodeAssert.equal(await NodeFSP.readFile(store.audioPath("job-00002"), "utf8"), "audio-bytes");
  },
);

NodeTest.test("rejects invalid metadata and path-like ids", async () => {
  const invalid = await fetch(`${base}/v1/jobs/job-00003`, {
    method: "PUT",
    headers: auth,
    body: body("x", { mode: "delete", threadId: "t" }),
  });
  NodeAssert.equal(invalid.status, 400);
  NodeAssert.equal(store.get("job-00003"), undefined);
  const noThread = await fetch(`${base}/v1/jobs/job-00003`, {
    method: "PUT",
    headers: auth,
    body: body("x", { mode: "send", threadId: "" }),
  });
  NodeAssert.equal(noThread.status, 400);
  const newTaskDraft = await fetch(`${base}/v1/jobs/job-00009`, {
    method: "PUT",
    headers: auth,
    body: body("x", { mode: "draft", threadId: "" }),
  });
  NodeAssert.equal(newTaskDraft.status, 201);
  const traversal = await fetch(`${base}/v1/jobs/..%2F..%2Fetc`, { headers: auth });
  NodeAssert.equal(traversal.status, 404);
});

NodeTest.test("reports status and accepts the phone's acknowledgement", async () => {
  const status = await fetch(`${base}/v1/jobs/job-00002`, { headers: auth });
  NodeAssert.equal(((await status.json()) as { status: string }).status, "queued");
  const ack = await fetch(`${base}/v1/jobs/job-00002/ack`, { method: "POST", headers: auth });
  NodeAssert.equal(ack.status, 200);
  NodeAssert.notEqual(store.get("job-00002")?.acknowledgedAt, null);
});

NodeTest.test("lets the phone take over sending until the service started on it", async () => {
  const claim = (id: string) =>
    fetch(`${base}/v1/jobs/${id}/claim`, { method: "POST", headers: auth });
  NodeAssert.equal((await claim("job-unknown")).status, 404);
  NodeAssert.equal((await claim("job-00002")).status, 200);
  NodeAssert.equal(store.get("job-00002")?.mode, "draft");
  await store.update("job-00002", { mode: "send", status: "sending" }, 1);
  NodeAssert.equal((await claim("job-00002")).status, 409);
  NodeAssert.equal(store.get("job-00002")?.mode, "send");
});

NodeTest.test("streams live audio and tells a phone that lost track where to resume", async () => {
  const live = (id: string, offset: number, audio: string, headers: object = auth) =>
    fetch(`${base}/v1/live/${id}?offset=${offset}&language=de`, {
      method: "PUT",
      headers: { ...headers },
      body: audio,
    });
  NodeAssert.equal((await live("job-00010", 0, "ab", {})).status, 401);
  const warmedBefore = warmed;
  const first = await live("job-00010", 0, "ab");
  NodeAssert.equal(warmed, warmedBefore + 1);
  NodeAssert.deepEqual(await first.json(), { received: 2, text: "heard ab" });
  const lost = await live("job-00010", 9, "zz");
  NodeAssert.equal(lost.status, 409);
  NodeAssert.equal(((await lost.json()) as { received: number }).received, 2);
  NodeAssert.equal((await live("..%2Fup", 0, "x")).status, 404);
  NodeAssert.equal((await live("job-00010", -1, "x")).status, 400);

  const upload = await fetch(`${base}/v1/jobs/job-00010`, {
    method: "PUT",
    headers: auth,
    body: body("audio"),
  });
  NodeAssert.equal(upload.status, 201);
  NodeAssert.ok(endedLive.includes("job-00010"));
  NodeAssert.equal((await live("job-00010", 2, "late")).status, 410);
});
