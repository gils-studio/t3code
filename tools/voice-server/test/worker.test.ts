import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { JobStore, type JobMeta } from "../src/jobStore.ts";
import { composeMessage, Worker, type ThreadSender, type Transcriber } from "../src/worker.ts";

const meta = (overrides: Partial<JobMeta> = {}): JobMeta => ({
  mode: "send",
  threadId: "thread-1",
  language: "de",
  prefixText: "",
  ...overrides,
});

async function harness(transcriber: Transcriber, sender: ThreadSender) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-"));
  const store = new JobStore(root);
  await store.load();
  let time = 1_000;
  const worker = new Worker({ store, transcriber, sender, now: () => time });
  const add = async (id: string, jobMeta = meta()) => {
    const partial = await store.partialAudioPath(id);
    await fs.writeFile(partial, "audio");
    time += 1;
    return store.create(id, jobMeta, partial, time);
  };
  return { root, store, worker, add, advance: (ms: number) => (time += ms) };
}

const sender = (sent: string[] = []): ThreadSender => ({
  send: async (_thread, text) => void sent.push(text),
  hasMessage: async (_thread, text) => sent.includes(text),
});

test("a voice message is transcribed and sent without the phone", async () => {
  const sent: string[] = [];
  const { store, worker, add } = await harness({ transcribe: async () => "hallo" }, sender(sent));
  await add("job-00001");
  await worker.runNext();
  assert.deepEqual(sent, ["hallo"]);
  assert.equal(store.get("job-00001")?.status, "done");
});

test("draft jobs wait for the phone and are never sent", async () => {
  const sent: string[] = [];
  const { store, worker, add } = await harness({ transcribe: async () => "text" }, sender(sent));
  await add("job-00002", meta({ mode: "draft" }));
  await worker.runNext();
  assert.deepEqual(sent, []);
  assert.equal(store.get("job-00002")?.transcript, "text");
});

test("recordings run strictly in order, one at a time", async () => {
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const { worker, add } = await harness(
    {
      transcribe: async (job) => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(job.id);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return job.id;
      },
    },
    sender(),
  );
  await add("job-first1");
  await add("job-second");
  while (await worker.runNext());
  assert.deepEqual(order, ["job-first1", "job-second"]);
  assert.equal(peak, 1);
});

test("a failed transcription retries and keeps the audio", async () => {
  let calls = 0;
  const { store, worker, add, advance } = await harness(
    {
      transcribe: async () => {
        calls += 1;
        if (calls === 1) throw new Error("gpu busy");
        return "ok";
      },
    },
    sender(),
  );
  await add("job-00003");
  await worker.runNext();
  assert.equal(store.get("job-00003")?.status, "queued");
  await fs.access(store.audioPath("job-00003"));
  assert.equal(await worker.runNext(), false);
  advance(60_000);
  await worker.runNext();
  assert.equal(store.get("job-00003")?.status, "done");
});

test("transcription that keeps failing ends as failed with the audio kept", async () => {
  const { store, worker, add, advance } = await harness(
    { transcribe: async () => Promise.reject(new Error("broken")) },
    sender(),
  );
  await add("job-00004");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await worker.runNext();
    advance(10 * 60_000);
  }
  assert.equal(store.get("job-00004")?.status, "failed");
  await fs.access(store.audioPath("job-00004"));
});

test("sending retries for as long as T3 is down", async () => {
  let online = false;
  const sent: string[] = [];
  const { store, worker, add, advance } = await harness(
    { transcribe: async () => "text" },
    {
      send: async (_thread, text) => {
        if (!online) throw new Error("server down");
        sent.push(text);
      },
      hasMessage: async () => false,
    },
  );
  await add("job-00005");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await worker.runNext();
    advance(10 * 60_000);
  }
  assert.equal(store.get("job-00005")?.status, "sending");
  online = true;
  await worker.runNext();
  assert.deepEqual(sent, ["text"]);
  assert.equal(store.get("job-00005")?.status, "done");
});

test("a crash during transcription resumes, and a crash after sending does not duplicate", async () => {
  const sent = ["hallo"];
  const { root, store, add } = await harness({ transcribe: async () => "x" }, sender(sent));
  await add("job-00006");
  await add("job-00007");
  await store.update("job-00006", { status: "transcribing" }, 5_000);
  await store.update(
    "job-00007",
    { status: "sending", transcript: "hallo", sendStarted: true },
    5_000,
  );

  const reloaded = new JobStore(root);
  await reloaded.load();
  const worker = new Worker({
    store: reloaded,
    transcriber: { transcribe: async () => "neu" },
    sender: sender(sent),
    now: () => 10_000,
  });
  await worker.recover();
  while (await worker.runNext());
  assert.equal(reloaded.get("job-00006")?.status, "done");
  assert.equal(reloaded.get("job-00007")?.status, "done");
  assert.deepEqual(sent, ["hallo", "neu"]);
});

test("nothing is sent when no speech was found", async () => {
  const sent: string[] = [];
  const { store, worker, add } = await harness({ transcribe: async () => "  " }, sender(sent));
  await add("job-00008");
  await worker.runNext();
  assert.deepEqual(sent, []);
  assert.equal(store.get("job-00008")?.status, "done");
});

test("typed draft text goes ahead of the transcript", () => {
  assert.equal(composeMessage("Kontext", "gesprochen"), "Kontext\n\ngesprochen");
  assert.equal(composeMessage("", "gesprochen"), "gesprochen");
});
