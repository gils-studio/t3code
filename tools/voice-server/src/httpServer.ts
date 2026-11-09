import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";

import { isValidJobId, type Job, type JobMeta, type JobStore } from "./jobStore.ts";

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_META_BYTES = 256 * 1024;
const MAX_LIVE_CHUNK_BYTES = 4 * 1024 * 1024;
const LANGUAGE_PATTERN = /^[a-z]{2,3}$|^auto$/;
const NEWLINE = 10;

export type LiveStream = {
  append(
    id: string,
    offset: number,
    bytes: Uint8Array,
    language: string,
  ): Promise<{ readonly accepted: boolean; readonly received: number; readonly text: string }>;
  end(id: string): Promise<void>;
};

export type HttpOptions = {
  readonly store: JobStore;
  readonly tokenHashes: () => ReadonlyArray<string>;
  readonly speakers: () => Readonly<Record<string, string>>;
  readonly environmentId: string;
  readonly onJobCreated: () => void;
  /** Loads the model ahead of the work; failures only cost that head start. */
  readonly warm: () => void;
  readonly live: LiveStream;
  readonly now?: () => number;
};

const hashOfBearer = (header: string) =>
  NodeCrypto.createHash("sha256").update(header.slice("Bearer ".length)).digest();

export function isAuthorized(header: string | undefined, hashes: ReadonlyArray<string>): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = hashOfBearer(header);
  return hashes.some((hash) => {
    const expected = Buffer.from(hash, "hex");
    return expected.length === candidate.length && NodeCrypto.timingSafeEqual(expected, candidate);
  });
}

/** For a request that passed isAuthorized. */
const speakerOf = (header: string, speakers: Readonly<Record<string, string>>) =>
  speakers[hashOfBearer(header).toString("hex")];

// Same rule as `pair`: one line that fits in the marker.
const SPEAKER_PATTERN = /^[^\]\r\n]{1,40}$/;

/** The phone's own name for its user wins over the name its token was paired with. */
export function parseMeta(line: string): (JobMeta & { readonly speaker?: string }) | null {
  try {
    const value = JSON.parse(line) as Partial<JobMeta> & { readonly speaker?: unknown };
    if (value.mode !== "draft" && value.mode !== "send") return null;
    // A draft job can come from a new task, which has no thread yet.
    const threadId = typeof value.threadId === "string" ? value.threadId : "";
    if (value.mode === "send" && threadId.length === 0) return null;
    const language = typeof value.language === "string" ? value.language : "auto";
    if (!LANGUAGE_PATTERN.test(language)) return null;
    return {
      mode: value.mode,
      threadId,
      language,
      prefixText: typeof value.prefixText === "string" ? value.prefixText : "",
      ...(typeof value.speaker === "string" && SPEAKER_PATTERN.test(value.speaker.trim())
        ? { speaker: value.speaker.trim() }
        : {}),
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
    speaker: job.speaker ?? null,
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
  let meta: ReturnType<typeof parseMeta> = null;
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
    const { speaker, ...jobMeta } = meta;
    return await store.create(
      id,
      jobMeta,
      partial,
      (options.now ?? Date.now)(),
      speaker ?? speakerOf(request.headers.authorization ?? "", options.speakers()),
    );
  } finally {
    output.destroy();
    await NodeFSP.rm(partial, { force: true });
  }
}

async function readBody(
  request: NodeHttp.IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return request.complete ? Buffer.concat(chunks) : null;
}

/** PUT /v1/live/:id?offset=N appends to the preview; 409 tells the phone where to resume. */
async function receiveLiveAudio(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  id: string,
  query: URLSearchParams,
  options: HttpOptions,
): Promise<void> {
  const offset = Number(query.get("offset"));
  const language = query.get("language") ?? "auto";
  if (!Number.isSafeInteger(offset) || offset < 0 || !LANGUAGE_PATTERN.test(language)) {
    request.resume();
    return sendJson(response, 400, { error: "invalid-live-audio" });
  }
  // The final upload ended this preview; a late chunk must not start it again.
  if (options.store.get(id)) {
    request.resume();
    return sendJson(response, 410, { error: "recording-finished" });
  }
  const bytes = await readBody(request, MAX_LIVE_CHUNK_BYTES);
  if (!bytes) return sendJson(response, 413, { error: "too-large" });
  options.warm();
  const { accepted, received, text } = await options.live.append(id, offset, bytes, language);
  sendJson(response, accepted ? 200 : 409, { received, text });
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
    const { pathname, searchParams } = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && pathname === "/v1/info") {
      sendJson(response, 200, { environmentId: options.environmentId });
      return;
    }
    const liveId = /^\/v1\/live\/([^/]+)$/.exec(pathname)?.[1];
    if (request.method === "PUT" && liveId && isValidJobId(liveId)) {
      return receiveLiveAudio(request, response, liveId, searchParams, options);
    }
    const match = /^\/v1\/jobs\/([^/]+)(\/ack|\/retry|\/claim)?$/.exec(pathname);
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
      options.warm();
      const job = await receiveUpload(request, id, options);
      if (job === "invalid") return sendJson(response, 400, { error: "invalid-upload" });
      if (job === "too-large") return sendJson(response, 413, { error: "too-large" });
      await options.live.end(id);
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
    if (request.method === "POST" && action === "/claim") {
      const claimed = await store.claim(id, now);
      sendJson(response, claimed ? 200 : 409, publicJob(store, store.get(id) ?? job));
      return;
    }
    if (request.method === "POST" && action === "/retry" && job.status === "failed") {
      const queued = await store.update(
        id,
        { status: "queued", attempts: 0, nextAttemptAt: 0, acceptUnclear: true },
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
