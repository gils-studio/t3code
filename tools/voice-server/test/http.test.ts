import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { createHttpServer } from "../src/httpServer.ts";
import { JobStore } from "../src/jobStore.ts";

const token = "device-token";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-http-"));
const store = new JobStore(root);
await store.load();
let created = 0;
const server = createHttpServer({
  store,
  tokenHashes: () => [createHash("sha256").update(token).digest("hex")],
  environmentId: "env-1",
  onJobCreated: () => (created += 1),
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const auth = { authorization: `Bearer ${token}` };
const body = (audio: string, meta: object = { mode: "send", threadId: "t", language: "de" }) =>
  `${JSON.stringify(meta)}\n${audio}`;

test("rejects requests without a valid token", async () => {
  assert.equal((await fetch(`${base}/v1/info`)).status, 401);
  const wrong = await fetch(`${base}/v1/info`, { headers: { authorization: "Bearer nope" } });
  assert.equal(wrong.status, 401);
  const upload = await fetch(`${base}/v1/jobs/job-00001`, { method: "PUT", body: body("a") });
  assert.equal(upload.status, 401);
  assert.equal(store.get("job-00001"), undefined);
});

test("reports the environment it belongs to", async () => {
  const response = await fetch(`${base}/v1/info`, { headers: auth });
  assert.deepEqual(await response.json(), { environmentId: "env-1" });
});

test("stores the audio before acknowledging and accepts a repeated upload once", async () => {
  const first = await fetch(`${base}/v1/jobs/job-00002`, {
    method: "PUT",
    headers: auth,
    body: body("audio-bytes"),
  });
  assert.equal(first.status, 201);
  assert.equal(await fs.readFile(store.audioPath("job-00002"), "utf8"), "audio-bytes");

  const before = created;
  const repeated = await fetch(`${base}/v1/jobs/job-00002`, {
    method: "PUT",
    headers: auth,
    body: body("other"),
  });
  assert.equal(repeated.status, 200);
  assert.equal(created, before);
  assert.equal(await fs.readFile(store.audioPath("job-00002"), "utf8"), "audio-bytes");
});

test("rejects invalid metadata and path-like ids", async () => {
  const invalid = await fetch(`${base}/v1/jobs/job-00003`, {
    method: "PUT",
    headers: auth,
    body: body("x", { mode: "delete", threadId: "t" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(store.get("job-00003"), undefined);
  const noThread = await fetch(`${base}/v1/jobs/job-00003`, {
    method: "PUT",
    headers: auth,
    body: body("x", { mode: "send", threadId: "" }),
  });
  assert.equal(noThread.status, 400);
  const newTaskDraft = await fetch(`${base}/v1/jobs/job-00009`, {
    method: "PUT",
    headers: auth,
    body: body("x", { mode: "draft", threadId: "" }),
  });
  assert.equal(newTaskDraft.status, 201);
  const traversal = await fetch(`${base}/v1/jobs/..%2F..%2Fetc`, { headers: auth });
  assert.equal(traversal.status, 404);
});

test("reports status and accepts the phone's acknowledgement", async () => {
  const status = await fetch(`${base}/v1/jobs/job-00002`, { headers: auth });
  assert.equal(((await status.json()) as { status: string }).status, "queued");
  const ack = await fetch(`${base}/v1/jobs/job-00002/ack`, { method: "POST", headers: auth });
  assert.equal(ack.status, 200);
  assert.notEqual(store.get("job-00002")?.acknowledgedAt, null);
});
