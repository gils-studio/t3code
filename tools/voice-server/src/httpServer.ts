import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";

import { isValidJobId, type Job, type JobMeta, type JobStore } from "./jobStore.ts";

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_META_BYTES = 256 * 1024;
const NEWLINE = 10;

export type HttpOptions = {
  readonly store: JobStore;
  readonly tokenHashes: () => ReadonlyArray<string>;
  readonly environmentId: string;
  readonly onJobCreated: () => void;
  readonly now?: () => number;
};

export function isAuthorized(header: string | undefined, hashes: ReadonlyArray<string>): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = NodeCrypto.createHash("sha256").update(header.slice("Bearer ".length)).digest();
  return hashes.some((hash) => {
    const expected = Buffer.from(hash, "hex");
    return expected.length === candidate.length && NodeCrypto.timingSafeEqual(expected, candidate);
  });
}

export function parseMeta(line: string): JobMeta | null {
  try {
    const value = JSON.parse(line) as Partial<JobMeta>;
    if (value.mode !== "draft" && value.mode !== "send") return null;
    // A draft job can come from a new task, which has no thread yet.
    const threadId = typeof value.threadId === "string" ? value.threadId : "";
    if (value.mode === "send" && threadId.length === 0) return null;
    const language = typeof value.language === "string" ? value.language : "auto";
    if (!/^[a-z]{2,3}$|^auto$/.test(language)) return null;
    return {
      mode: value.mode,
      threadId,
      language,
      prefixText: typeof value.prefixText === "string" ? value.prefixText : "",
    };
  } catch {
    return null;
  }
}

function sendJson(response: NodeHttp.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function publicJob(store: JobStore, job: Job) {
  return {
    id: job.id,
    status: job.status,
    transcript: job.transcript,
    queuePosition: store.queuePosition(job.id),
    lastError: job.lastError,
  };
}

/**
 * Body of PUT /v1/jobs/:id is one line of JSON metadata, then the raw audio.
 * Metadata stays out of headers because a typed draft can exceed proxy limits.
 * The response is sent only after the audio is durably on disk.
 */
async function receiveUpload(
  request: NodeHttp.IncomingMessage,
  id: string,
  options: HttpOptions,
): Promise<Job | "invalid" | "too-large"> {
  const { store } = options;
  const partial = await store.partialAudioPath(id);
  const output = NodeFS.createWriteStream(partial);
  let header = Buffer.alloc(0);
  let meta: JobMeta | null = null;
  let received = 0;
  try {
    for await (const chunk of request as AsyncIterable<Buffer>) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) return "too-large";
      let audio: Buffer = chunk;
      if (!meta) {
        header = Buffer.concat([header, chunk]);
        const newline = header.indexOf(NEWLINE);
        if (newline === -1) {
          if (header.length > MAX_META_BYTES) return "invalid";
          continue;
        }
        meta = parseMeta(header.subarray(0, newline).toString("utf8"));
        if (!meta) return "invalid";
        audio = header.subarray(newline + 1);
      }
      if (!output.write(audio)) {
        await new Promise<void>((resolve) => output.once("drain", () => resolve()));
      }
    }
    if (!request.complete || !meta) return "invalid";
    await new Promise<void>((resolve, reject) =>
      output.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
    const handle = await NodeFSP.open(partial, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return await store.create(id, meta, partial, (options.now ?? Date.now)());
  } finally {
    output.destroy();
    await NodeFSP.rm(partial, { force: true });
  }
}

export function createHttpServer(options: HttpOptions): NodeHttp.Server {
  const { store } = options;
  const handle = async (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ): Promise<void> => {
    if (!isAuthorized(request.headers.authorization, options.tokenHashes())) {
      request.resume();
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && pathname === "/v1/info") {
      sendJson(response, 200, { environmentId: options.environmentId });
      return;
    }
    const match = /^\/v1\/jobs\/([^/]+)(\/ack|\/retry)?$/.exec(pathname);
    const id = match?.[1];
    if (!id || !isValidJobId(id)) {
      request.resume();
      sendJson(response, 404, { error: "not-found" });
      return;
    }
    const action = match?.[2];
    if (request.method === "PUT" && !action) {
      const existing = store.get(id);
      if (existing) {
        request.resume();
        sendJson(response, 200, publicJob(store, existing));
        return;
      }
      const job = await receiveUpload(request, id, options);
      if (job === "invalid") return sendJson(response, 400, { error: "invalid-upload" });
      if (job === "too-large") return sendJson(response, 413, { error: "too-large" });
      options.onJobCreated();
      sendJson(response, 201, publicJob(store, job));
      return;
    }
    const job = store.get(id);
    if (!job) {
      request.resume();
      sendJson(response, 404, { error: "not-found" });
      return;
    }
    const now = (options.now ?? Date.now)();
    if (request.method === "GET" && !action) {
      sendJson(response, 200, publicJob(store, job));
      return;
    }
    if (request.method === "POST" && action === "/ack") {
      const acknowledged = await store.update(id, { acknowledgedAt: now }, now);
      sendJson(response, 200, publicJob(store, acknowledged));
      return;
    }
    if (request.method === "POST" && action === "/retry" && job.status === "failed") {
      const queued = await store.update(
        id,
        { status: "queued", attempts: 0, nextAttemptAt: 0 },
        now,
      );
      options.onJobCreated();
      sendJson(response, 200, publicJob(store, queued));
      return;
    }
    sendJson(response, 405, { error: "method-not-allowed" });
  };

  return NodeHttp.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      console.error("request failed", error);
      if (!response.headersSent) sendJson(response, 500, { error: "internal" });
      else response.destroy();
    });
  });
}
