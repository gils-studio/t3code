import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { decodeToWav, isSilent, T3CliSender, WhisperTranscriber } from "./adapters.ts";
import { dataDirectory, readConfig, writeLink } from "./config.ts";
import { createHttpServer } from "./httpServer.ts";
import { JobStore } from "./jobStore.ts";
import { LiveTranscriber } from "./live.ts";
import { correctTranscript } from "./vocabulary.ts";
import { closeLeftoverProcess, WhisperServer } from "./whisperServer.ts";
import { Worker } from "./worker.ts";

const LIVE_RECOGNIZE_TIMEOUT_MILLIS = 30_000;
const LIVE_PURGE_INTERVAL_MILLIS = 60_000;

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

async function serve(): Promise<void> {
  const config = await readConfig();
  const environmentId = (
    await NodeFSP.readFile(
      NodePath.join(NodeOS.homedir(), ".t3", "userdata", "environment-id"),
      "utf8",
    )
  ).trim();
  // New per start: only the T3 server reads the link file, and it reads it per request.
  const token = NodeCrypto.randomBytes(32).toString("base64url");
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
    token,
    environmentId,
    onJobCreated: () => worker.notify(),
    warm: () => {
      whisper.warm().catch((error: unknown) => log(`warm-up failed: ${String(error)}`));
    },
    live,
  });
  server.requestTimeout = 0;
  server.listen(config.port, "127.0.0.1", () => {
    log(`listening on 127.0.0.1:${config.port}`);
    void writeLink({ url: `http://127.0.0.1:${config.port}`, token, environmentId }).catch(
      (error: unknown) => log(`writing the T3 link failed: ${String(error)}`),
    );
  });

  const shutdown = () => {
    server.close();
    whisper.stop();
    void worker.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await serve();
