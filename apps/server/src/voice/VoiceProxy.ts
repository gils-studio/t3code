// @effect-diagnostics nodeBuiltinImport:off -- the voice service's link file sits in the user's home, which Effect's Path does not expose.
import * as NodeOS from "node:os";
import { VOICE_ROUTE_PREFIX, VoiceAccessSigningKeyError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { requestUrl } from "../requestUrl.ts";

const SIGNING_SECRET_NAME = "voice-access-signing-key";
// The phone's background upload keeps the URL while it is offline; each connect renews it.
const ACCESS_TTL_MS = 30 * 24 * 60 * 60_000;
const VOICE_API_PATH = /^\/v1\/(info|jobs\/[^/]+(\/(ack|retry|claim|send))?|live\/[^/]+)$/;

/** Written by the voice service at start; it only sends into the environment it names. */
const VoiceLinkFile = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  environmentId: Schema.String,
});
export type VoiceLinkFile = typeof VoiceLinkFile.Type;
const decodeVoiceLinkFile = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceLinkFile));

export class VoiceLink extends Context.Service<
  VoiceLink,
  { readonly read: Effect.Effect<VoiceLinkFile | null> }
>()("t3/voice/VoiceProxy/VoiceLink") {}

/** Read per request, so the service can start, stop or move ports while T3 runs. */
export const layerVoiceLink = Layer.effect(
  VoiceLink,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const linkPath =
      process.env.T3CODE_VOICE_LINK ?? path.join(NodeOS.homedir(), ".t3-voice", "t3-link.json");
    return {
      read: fileSystem.readFileString(linkPath).pipe(
        Effect.map((text) => Option.getOrNull(decodeVoiceLinkFile(text))),
        Effect.orElseSucceed(() => null),
      ),
    };
  }),
);

/** The link counts only for the environment the service sends into. */
const currentLink = Effect.gen(function* () {
  const link = yield* (yield* VoiceLink).read;
  if (!link) return null;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  return link.environmentId === environmentId ? link : null;
});

const VoiceAccessClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("voice"),
  expiresAt: Schema.Number,
});
const voiceAccessClaimsJson = Schema.fromJsonString(VoiceAccessClaims);
const decodeVoiceAccessClaims = Schema.decodeUnknownOption(voiceAccessClaimsJson);
const encodeVoiceAccessClaims = Schema.encodeSync(voiceAccessClaimsJson);

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

export const issueVoiceAccessUrl = Effect.fn("VoiceProxy.issueAccessUrl")(function* () {
  if (!(yield* currentLink)) return { relativeUrl: null };
  const secret = yield* loadSigningSecret.pipe(
    Effect.mapError((cause) => new VoiceAccessSigningKeyError({ cause })),
  );
  const encodedPayload = base64UrlEncode(
    encodeVoiceAccessClaims({
      version: 1,
      kind: "voice",
      expiresAt: (yield* Clock.currentTimeMillis) + ACCESS_TTL_MS,
    }),
  );
  return {
    relativeUrl: `${VOICE_ROUTE_PREFIX}/${encodedPayload}.${signPayload(encodedPayload, secret)}`,
  };
});

function decodeClaims(encodedPayload: string): typeof VoiceAccessClaims.Type | null {
  try {
    return Option.getOrNull(decodeVoiceAccessClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

export const isValidToken = Effect.fn("VoiceProxy.isValidToken")(function* (token: string) {
  const [encodedPayload, signature, unexpectedSegment] = token.split(".");
  if (!encodedPayload || !signature || unexpectedSegment) return false;
  const secret = yield* loadSigningSecret.pipe(Effect.orElseSucceed(() => null));
  if (!secret || !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) {
    return false;
  }
  const claims = decodeClaims(encodedPayload);
  return claims !== null && claims.expiresAt > (yield* Clock.currentTimeMillis);
});

const notFound = () => HttpServerResponse.text("Not Found", { status: 404 });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const rest = url.value.pathname.slice(`${VOICE_ROUTE_PREFIX}/`.length);
  const separator = rest.indexOf("/");
  if (separator <= 0) return notFound();
  const apiPath = rest.slice(separator);
  if (!VOICE_API_PATH.test(apiPath) || !(yield* isValidToken(rest.slice(0, separator)))) {
    return notFound();
  }
  const method = request.method;
  if (!HttpMethod.isHttpMethod(method)) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const link = yield* currentLink;
  if (!link) return HttpServerResponse.text("Voice service is not running", { status: 503 });

  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const upstreamRequest = HttpClientRequest.make(method)(
    `${link.url}${apiPath}${url.value.search}`,
  ).pipe(
    HttpClientRequest.setHeaders({ authorization: `Bearer ${link.token}` }),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"] ?? "application/octet-stream",
        }),
  );
  return yield* httpClient.execute(upstreamRequest).pipe(
    Effect.map((response) =>
      HttpServerResponse.stream(response.stream, {
        status: response.status,
        contentType: response.headers["content-type"] ?? "application/octet-stream",
        headers: { "cache-control": "no-store" },
      }),
    ),
    Effect.tapError((cause) =>
      Effect.logWarning("Voice service request failed.", { reason: cause.reason._tag }),
    ),
    Effect.orElseSucceed(() =>
      HttpServerResponse.text("Voice service is not reachable", { status: 502 }),
    ),
  );
});

export const layerRoute = HttpRouter.add("*", `${VOICE_ROUTE_PREFIX}/*`, handler);
