import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { T3CliSender, WhisperTranscriber } from "./adapters.ts";
import { dataDirectory, readConfig, writeConfig, type Config } from "./config.ts";
import { createHttpServer } from "./httpServer.ts";
import { JobStore } from "./jobStore.ts";
import { Worker } from "./worker.ts";

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

/** Prints a deep link once; only the token's hash is kept. */
async function pair(): Promise<void> {
  const config = await readConfig();
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await writeConfig({ ...config, tokenHashes: [...config.tokenHashes, hash] });
  const query = new URLSearchParams({ url: config.publicUrl, token });
  console.log(`t3code-preview://voice-pair?${query.toString()}`);
}

/** The phone reaches the service through the sish tunnel; ssh is restarted when it drops. */
function keepTunnelOpen(config: Config, isStopped: () => boolean): void {
  if (!config.tunnelName) return;
  const open = () => {
    if (isStopped()) return;
    const child = spawn(
      "ssh",
      ["devtunnel", "-N", "-R", `${config.tunnelName}:80:127.0.0.1:${config.port}`],
      { stdio: "ignore", windowsHide: true },
    );
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
    await fs.readFile(path.join(os.homedir(), ".t3", "userdata", "environment-id"), "utf8")
  ).trim();
  const store = new JobStore(path.join(dataDirectory(), "jobs"));
  await store.load();
  const worker = new Worker({
    store,
    transcriber: new WhisperTranscriber(config, store),
    sender: new T3CliSender(config),
    log,
  });
  await worker.recover();
  worker.start();

  const server = createHttpServer({
    store,
    tokenHashes: () => config.tokenHashes,
    environmentId,
    onJobCreated: () => worker.notify(),
  });
  server.requestTimeout = 0;
  server.listen(config.port, "127.0.0.1", () => log(`listening on 127.0.0.1:${config.port}`));

  let stopped = false;
  keepTunnelOpen(config, () => stopped);
  const shutdown = () => {
    stopped = true;
    server.close();
    void worker.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[2] === "pair") await pair();
else await serve();
