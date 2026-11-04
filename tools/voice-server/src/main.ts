import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { decodeToWav, isSilent, T3CliSender, WhisperTranscriber } from "./adapters.ts";
import {
  dataDirectory,
  readConfig,
  readSpeakers,
  readTokenHashes,
  writeConfig,
  type Config,
} from "./config.ts";
import { createHttpServer } from "./httpServer.ts";
import { JobStore } from "./jobStore.ts";
import { LiveTranscriber } from "./live.ts";
import { correctTranscript } from "./vocabulary.ts";
import { closeLeftoverProcess, WhisperServer } from "./whisperServer.ts";
import { Worker } from "./worker.ts";

const LIVE_RECOGNIZE_TIMEOUT_MILLIS = 30_000;
const LIVE_PURGE_INTERVAL_MILLIS = 60_000;

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

const SPEAKER_PATTERN = /^[^\]\r\n]{1,40}$/;

/** Prints a deep link once; only the token's hash is kept. */
async function pair(speaker: string | undefined): Promise<void> {
  if (speaker !== undefined && !SPEAKER_PATTERN.test(speaker)) {
    throw new Error("A speaker name has at most 40 characters and no closing bracket.");
  }
  const config = await readConfig();
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const hash = NodeCrypto.createHash("sha256").update(token).digest("hex");
  await writeConfig({
    ...config,
    tokenHashes: [...config.tokenHashes, hash],
    ...(speaker ? { speakers: { ...config.speakers, [hash]: speaker } } : {}),
  });
  const query = new URLSearchParams({ url: config.publicUrl, token });
  console.log(`t3code-preview://voice-pair?${query.toString()}`);
}

/** The phone reaches the service through the sish tunnel; ssh is restarted when it drops. */
async function keepTunnelOpen(config: Config, isStopped: () => boolean): Promise<void> {
  if (!config.tunnelName) return;
  const pidFile = NodePath.join(dataDirectory(), "tunnel.pid");
  await closeLeftoverProcess(pidFile, "ssh.exe");
  const open = () => {
    if (isStopped()) return;
    const child = NodeChildProcess.spawn(
      "ssh",
      ["devtunnel", "-N", "-R", `${config.tunnelName}:80:127.0.0.1:${config.port}`],
      { stdio: "ignore", windowsHide: true },
    );
    if (child.pid) void NodeFSP.writeFile(pidFile, String(child.pid));
    child.on("error", (error) => log(`tunnel error: ${String(error)}`));
    child.on("close", () => {
      log("tunnel closed, reconnecting");
      setTimeout(open, 5_000);
    });
  };
  open();
}

async function serve(): Promise<void> {
  const config = await readConfig();
  const environmentId = (
    await NodeFSP.readFile(
      NodePath.join(NodeOS.homedir(), ".t3", "userdata", "environment-id"),
      "utf8",
    )
  ).trim();
  const store = new JobStore(NodePath.join(dataDirectory(), "jobs"));
  await store.load();
  const whisperPidFile = NodePath.join(dataDirectory(), "whisper.pid");
  await closeLeftoverProcess(whisperPidFile, "whisper-server.exe");
  const whisper = new WhisperServer(config, whisperPidFile, log);
  const worker = new Worker({
    store,
    transcriber: new WhisperTranscriber(config, store, whisper, log),
    sender: new T3CliSender(config),
    log,
  });
  await worker.recover();
  worker.start();

  const live = new LiveTranscriber({
    directory: NodePath.join(dataDirectory(), "live"),
    decode: async (audio, wav, startSeconds) => {
      await decodeToWav(config, audio, wav, startSeconds);
    },
    isSilent: (wav) => isSilent(config, wav),
    recognize: (wav, language) =>
      whisper.recognize(wav, language, {
        timeoutMillis: LIVE_RECOGNIZE_TIMEOUT_MILLIS,
        preview: true,
      }),
    isBusy: () =>
      store.all().some((job) => job.status === "queued" || job.status === "transcribing"),
    correct: correctTranscript,
    log,
  });
  await live.reset();
  setInterval(() => void live.purgeIdle(), LIVE_PURGE_INTERVAL_MILLIS).unref();

  const server = createHttpServer({
    store,
    tokenHashes: readTokenHashes,
    speakers: readSpeakers,
    environmentId,
    onJobCreated: () => worker.notify(),
    warm: () => {
      whisper.warm().catch((error: unknown) => log(`warm-up failed: ${String(error)}`));
    },
    live,
  });
  server.requestTimeout = 0;
  server.listen(config.port, "127.0.0.1", () => log(`listening on 127.0.0.1:${config.port}`));

  let stopped = false;
  void keepTunnelOpen(config, () => stopped);
  const shutdown = () => {
    stopped = true;
    server.close();
    whisper.stop();
    void worker.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[2] === "pair") await pair(process.argv[3]);
else await serve();
