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
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-http-"));
const store = new JobStore(root);
await store.load();
let created = 0;
const server = createHttpServer({
  store,
  tokenHashes: () => [NodeCrypto.createHash("sha256").update(token).digest("hex")],
  environmentId: "env-1",
  onJobCreated: () => (created += 1),
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
NodeTest.after(() => server.close());

const auth = { authorization: `Bearer ${token}` };
const body = (audio: string, meta: object = { mode: "send", threadId: "t", language: "de" }) =>
  `${JSON.stringify(meta)}\n${audio}`;

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

NodeTest.test("stores the audio before acknowledging and accepts a repeated upload once", async () => {
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
});

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
