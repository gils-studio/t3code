import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { foundNoSpeech, transcriptionTimeoutMillis } from "../src/adapters.ts";
import { JobStore, type JobMeta } from "../src/jobStore.ts";
import { voiceMessagePrefix } from "../src/adapters.ts";
import { composeMessage, Worker, type ThreadSender, type Transcriber } from "../src/worker.ts";

const meta = (overrides: Partial<JobMeta> = {}): JobMeta => ({
  mode: "send",
  threadId: "thread-1",
  language: "de",
  prefixText: "",
  ...overrides,
});

async function harness(transcriber: Transcriber, sender: ThreadSender) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-"));
  const store = new JobStore(root);
  await store.load();
  let time = 1_000;
  const worker = new Worker({ store, transcriber, sender, now: () => time });
  const add = async (id: string, jobMeta = meta()) => {
    const partial = await store.partialAudioPath(id);
    await NodeFSP.writeFile(partial, "audio");
    time += 1;
    return store.create(id, jobMeta, partial, time);
  };
  return { root, store, worker, add, advance: (ms: number) => (time += ms) };
}

const sender = (sent: string[] = []): ThreadSender => ({
  send: async (_thread, text) => void sent.push(text),
  hasMessage: async (_thread, text) => sent.includes(text),
});

NodeTest.test("a voice message is transcribed and sent without the phone", async () => {
  const sent: string[] = [];
  const { store, worker, add } = await harness({ transcribe: async () => "hallo" }, sender(sent));
  await add("job-00001");
  await worker.runNext();
  NodeAssert.deepEqual(sent, ["hallo"]);
  NodeAssert.equal(store.get("job-00001")?.status, "done");
});

NodeTest.test("the message carries the speaker of the recording", async () => {
  const speakers: Array<string | undefined> = [];
  const { store, worker } = await harness(
    { transcribe: async () => "text" },
    {
      send: async (_thread, _text, speaker) => void speakers.push(speaker),
      hasMessage: async () => false,
    },
  );
  const partial = await store.partialAudioPath("job-speaker");
  await NodeFSP.writeFile(partial, "audio");
  await store.create("job-speaker", jobMeta, partial, 1, "Nils");
  await worker.runNext();
  NodeAssert.deepEqual(speakers, ["Nils"]);
  NodeAssert.equal(voiceMessagePrefix("Nils"), "[Voice message from Nils]\n\n");
  NodeAssert.equal(voiceMessagePrefix(), "[Voice message]\n\n");
});

NodeTest.test("draft jobs wait for the phone and are never sent", async () => {
  const sent: string[] = [];
  const { store, worker, add } = await harness({ transcribe: async () => "text" }, sender(sent));
  await add("job-00002", meta({ mode: "draft" }));
  await worker.runNext();
  NodeAssert.deepEqual(sent, []);
  NodeAssert.equal(store.get("job-00002")?.transcript, "text");
});

NodeTest.test("recordings run strictly in order, one at a time", async () => {
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const { worker, add } = await harness(
    {
      transcribe: async (job) => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(job.id);
        await Promise.resolve();
        active -= 1;
        return job.id;
      },
    },
    sender(),
  );
  await add("job-first1");
  await add("job-second");
  while (await worker.runNext());
  NodeAssert.deepEqual(order, ["job-first1", "job-second"]);
  NodeAssert.equal(peak, 1);
});

NodeTest.test("a failed transcription retries and keeps the audio", async () => {
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
  NodeAssert.equal(store.get("job-00003")?.status, "queued");
  await NodeFSP.access(store.audioPath("job-00003"));
  NodeAssert.equal(await worker.runNext(), false);
  advance(60_000);
  await worker.runNext();
  NodeAssert.equal(store.get("job-00003")?.status, "done");
});

NodeTest.test("transcription that keeps failing ends as failed with the audio kept", async () => {
  const { store, worker, add, advance } = await harness(
    { transcribe: async () => Promise.reject(new Error("broken")) },
    sender(),
  );
  await add("job-00004");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await worker.runNext();
    advance(10 * 60_000);
  }
  NodeAssert.equal(store.get("job-00004")?.status, "failed");
  await NodeFSP.access(store.audioPath("job-00004"));
});

NodeTest.test("sending retries for as long as T3 is down", async () => {
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
  NodeAssert.equal(store.get("job-00005")?.status, "sending");
  online = true;
  await worker.runNext();
  NodeAssert.deepEqual(sent, ["text"]);
  NodeAssert.equal(store.get("job-00005")?.status, "done");
});

NodeTest.test(
  "a crash during transcription resumes, and a crash after sending does not duplicate",
  async () => {
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
    NodeAssert.equal(reloaded.get("job-00006")?.status, "done");
    NodeAssert.equal(reloaded.get("job-00007")?.status, "done");
    NodeAssert.deepEqual(sent, ["hallo", "neu"]);
  },
);

NodeTest.test("nothing is sent when no speech was found", async () => {
  for (const silence of ["  ", "* Musik *", " [BLANK_AUDIO] (Stille) "]) {
    const sent: string[] = [];
    const { store, worker, add } = await harness({ transcribe: async () => silence }, sender(sent));
    await add("job-00008");
    await worker.runNext();
    NodeAssert.deepEqual(sent, []);
    NodeAssert.equal(store.get("job-00008")?.status, "done");
    NodeAssert.equal(store.get("job-00008")?.transcript, "");
  }
});

NodeTest.test("speech next to a noise marker is kept whole", async () => {
  const sent: string[] = [];
  const { worker, add } = await harness(
    { transcribe: async () => "* Musik * Hallo (leise)" },
    sender(sent),
  );
  await add("job-00009");
  await worker.runNext();
  NodeAssert.deepEqual(sent, ["* Musik * Hallo (leise)"]);
});

NodeTest.test("only a clear zero from the VAD counts as silence", () => {
  NodeAssert.equal(foundNoSpeech("Detected 0 speech segments:"), true);
  NodeAssert.equal(foundNoSpeech("Detected 3 speech segments:"), false);
  NodeAssert.equal(foundNoSpeech(""), false);
});

NodeTest.test("typed draft text goes ahead of the transcript", () => {
  NodeAssert.equal(composeMessage("Kontext", "gesprochen"), "Kontext\n\ngesprochen");
  NodeAssert.equal(composeMessage("", "gesprochen"), "gesprochen");
});

NodeTest.test("a long recording gets a timeout the whisper-server request accepts", () => {
  const millis = transcriptionTimeoutMillis(51.7784375);
  NodeAssert.ok(millis > 120_000);
  NodeAssert.doesNotThrow(() => AbortSignal.timeout(millis));
});

NodeTest.test("a job claimed during transcription is left to the phone", async () => {
  const sent: string[] = [];
  const { store, worker, add } = await harness(
    {
      transcribe: async (job) => {
        NodeAssert.equal(await store.claim(job.id, 2_000), true);
        return "hallo";
      },
    },
    sender(sent),
  );
  await add("job-claim1");
  await worker.runNext();
  NodeAssert.deepEqual(sent, []);
  NodeAssert.equal(store.get("job-claim1")?.status, "done");
  NodeAssert.equal(store.get("job-claim1")?.transcript, "hallo");
});

NodeTest.test("a job the service started sending can no longer be claimed", async () => {
  const sent: string[] = [];
  const { store, worker, add } = await harness({ transcribe: async () => "hallo" }, sender(sent));
  await add("job-claim2");
  await worker.runNext();
  NodeAssert.equal(await store.claim("job-claim2", 2_000), false);
  NodeAssert.deepEqual(sent, ["hallo"]);
});
