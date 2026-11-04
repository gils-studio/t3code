import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { LiveTranscriber } from "../src/live.ts";
import type { SpeechSegment } from "../src/whisperServer.ts";

const segment = (start: number, end: number, text: string): SpeechSegment => ({ start, end, text });

async function harness(answers: ReadonlyArray<ReadonlyArray<SpeechSegment>>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-live-"));
  const state = {
    busy: false,
    silent: false,
    wavBytes: 0,
    now: 0,
    starts: [] as number[],
    recognized: 0,
  };
  const live = new LiveTranscriber({
    directory,
    decode: async (_audio, wav, startSeconds) => {
      state.starts.push(startSeconds);
      await NodeFSP.writeFile(wav, Buffer.alloc(state.wavBytes));
    },
    isSilent: async () => state.silent,
    recognize: async () => ({ segments: answers[state.recognized++] ?? [] }),
    isBusy: () => state.busy,
    correct: (text) => text.replace("Pidor", "Pidohr"),
    now: () => state.now,
  });
  await live.reset();
  let offset = 0;
  const speak = async (id = "voice-1") => {
    const result = await live.append(id, offset, Buffer.from("aa"), "de");
    offset = result.received;
    await live.pump();
    return (await live.append(id, offset, new Uint8Array(), "de")).text;
  };
  return { directory, live, state, speak };
}

NodeTest.test("appends in order and reports where a lost phone must resume", async () => {
  const { directory, live } = await harness([]);
  NodeAssert.equal((await live.append("voice-1", 0, Buffer.from("ab"), "de")).received, 2);
  const lost = await live.append("voice-1", 7, Buffer.from("xx"), "de");
  NodeAssert.deepEqual([lost.accepted, lost.received], [false, 2]);
  NodeAssert.equal(await NodeFSP.readFile(NodePath.join(directory, "voice-1.aac"), "utf8"), "ab");
});

NodeTest.test("a long talk settles old words and only decodes the recent window", async () => {
  const { state, speak } = await harness([
    [segment(0, 4, " Hallo")],
    [segment(0, 9, " Hallo Welt"), segment(9, 14, " und wei"), segment(14, 17, "ter")],
    [segment(0, 3, " und weiter so")],
  ]);
  NodeAssert.equal(await speak(), "Hallo");
  NodeAssert.equal(await speak(), "Hallo Welt und weiter");
  NodeAssert.equal(await speak(), "Hallo Welt und weiter so");
  NodeAssert.deepEqual(state.starts, [0, 0, 9]);
});

NodeTest.test("a name split across a settled window is still corrected", async () => {
  const { state, speak } = await harness([
    [segment(0, 9, " Die App"), segment(9, 14, " Pi"), segment(14, 17, "dor")],
    [segment(0, 3, "dor")],
  ]);
  state.wavBytes = 20 * 32_000;
  NodeAssert.equal(await speak(), "Die App Pidohr");
});

NodeTest.test("noise markers and silence never reach the preview", async () => {
  const { state, speak } = await harness([[segment(0, 2, " * Musik *")]]);
  NodeAssert.equal(await speak(), "");
  state.silent = true;
  state.wavBytes = 20 * 32_000;
  NodeAssert.equal(await speak(), "");
  NodeAssert.equal(state.recognized, 1);
  await speak();
  NodeAssert.equal(state.starts.at(-1), 20);
});

NodeTest.test("a pass that hears nothing keeps the words already on screen", async () => {
  const { speak } = await harness([[segment(0, 2, " Hallo")], [], [segment(0, 2, " * Musik *")]]);
  NodeAssert.equal(await speak(), "Hallo");
  NodeAssert.equal(await speak(), "Hallo");
  NodeAssert.equal(await speak(), "Hallo");
});

NodeTest.test("waits while a finished recording is being transcribed", async () => {
  const { live, state, speak } = await harness([[segment(0, 2, " spaeter")]]);
  state.busy = true;
  NodeAssert.equal(await speak(), "");
  NodeAssert.equal(state.recognized, 0);
  state.busy = false;
  await live.pump();
  NodeAssert.equal(state.recognized, 1);
});

NodeTest.test("a failed update leaves the preview running", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-live-"));
  let calls = 0;
  const live = new LiveTranscriber({
    directory,
    decode: async () => {
      calls += 1;
      if (calls === 1) throw new Error("truncated frame");
    },
    isSilent: async () => false,
    recognize: async () => ({ segments: [segment(0, 1, " wieder da")] }),
    isBusy: () => false,
    correct: (text) => text,
  });
  await live.append("voice-1", 0, Buffer.from("a"), "de");
  await live.pump();
  await live.append("voice-1", 1, Buffer.from("b"), "de");
  await live.pump();
  NodeAssert.equal((await live.append("voice-1", 2, new Uint8Array(), "de")).text, "wieder da");
});

NodeTest.test("audio leaves the disk when a recording ends or goes quiet", async () => {
  const { directory, live, state } = await harness([]);
  await live.append("voice-1", 0, Buffer.from("a"), "de");
  await live.append("voice-2", 0, Buffer.from("b"), "de");
  await live.pump();
  await live.end("voice-1");
  state.now = 6 * 60_000;
  await live.purgeIdle();
  NodeAssert.deepEqual(await NodeFSP.readdir(directory), []);
});
