import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, VOICE_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode, signPayload } from "../auth/utils.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as VoiceProxy from "./VoiceProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const LINK = { url: "http://127.0.0.1:4791", token: "link-token", environmentId: "env-pc" };
const SECRET = new Uint8Array(32).fill(7);

const services = (link: VoiceProxy.VoiceLinkFile | null = LINK) =>
  Layer.mergeAll(
    Layer.succeed(VoiceProxy.VoiceLink, { read: Effect.succeed(link) }),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-pc")),
    } as ServerEnvironment.ServerEnvironment["Service"]),
    Layer.succeed(ServerSecretStore.ServerSecretStore, {
      getOrCreateRandom: () => Effect.succeed(SECRET),
    } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
  );

// The route runs on the wall clock, so its token never expires instead of following TestClock.
const payload = base64UrlEncode(
  JSON.stringify({ version: 1, kind: "voice", expiresAt: Number.MAX_SAFE_INTEGER }),
);
const signedUrl = `http://t3.test${VOICE_ROUTE_PREFIX}/${payload}.${signPayload(payload, SECRET)}`;

const proxy = () => {
  const forwarded: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Stream"
          ? yield* Stream.mkString(Stream.decodeText(request.body.stream)).pipe(Effect.orDie)
          : "";
      forwarded.push({ url: request.url, headers: { ...request.headers }, body });
      return HttpClientResponse.fromWeb(
        request,
        new Response('{"id":"voice-1"}', {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    VoiceProxy.layerRoute.pipe(
      Layer.provideMerge(Layer.merge(services(), Layer.succeed(HttpClient.HttpClient, client))),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, forwarded };
};

describe("voice proxy", () => {
  it("forwards a signed request to the voice service with the link token", async () => {
    const { handler, forwarded } = proxy();
    const response = await handler(
      new Request(`${signedUrl}/v1/jobs/voice-1`, {
        method: "PUT",
        headers: { authorization: "Bearer phone", "content-type": "application/octet-stream" },
        body: '{"mode":"draft"}\naudio',
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"id":"voice-1"}');
    expect(forwarded).toEqual([
      {
        url: "http://127.0.0.1:4791/v1/jobs/voice-1",
        headers: expect.objectContaining({ authorization: "Bearer link-token" }),
        body: '{"mode":"draft"}\naudio',
      },
    ]);
  });

  it("refuses tampered tokens and paths outside the voice API", async () => {
    const { handler, forwarded } = proxy();
    expect((await handler(new Request(`${signedUrl.slice(0, -2)}xx/v1/info`))).status).toBe(404);
    expect((await handler(new Request(`${signedUrl}/admin`))).status).toBe(404);
    expect(forwarded).toEqual([]);
  });

  it.effect("issues a URL only for a voice service sending into this environment", () =>
    Effect.gen(function* () {
      const issued = yield* VoiceProxy.issueVoiceAccessUrl().pipe(Effect.provide(services()));
      const token = issued.relativeUrl?.slice(`${VOICE_ROUTE_PREFIX}/`.length) ?? "";
      expect(yield* VoiceProxy.isValidToken(token).pipe(Effect.provide(services()))).toBe(true);
      expect(yield* VoiceProxy.issueVoiceAccessUrl().pipe(Effect.provide(services(null)))).toEqual(
        { relativeUrl: null },
      );
      const elsewhere = services({ ...LINK, environmentId: "env-other" });
      expect(yield* VoiceProxy.issueVoiceAccessUrl().pipe(Effect.provide(elsewhere))).toEqual({
        relativeUrl: null,
      });
    }),
  );
});
