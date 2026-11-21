import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as VoiceProxy from "./VoiceProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const LINK = { url: "http://127.0.0.1:4791", token: "link-token", environmentId: "env-pc" };

const fixture = (link: VoiceProxy.VoiceLinkFile | null = LINK) => {
  const forwarded: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Stream"
          ? yield* Effect.promise(() => new Response(request.body.toReadableStream()).text())
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
  const services = Layer.mergeAll(
    Layer.succeed(VoiceProxy.VoiceLink, { read: Effect.succeed(link) }),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-pc")),
    } as ServerEnvironment.ServerEnvironment["Service"]),
    Layer.succeed(ServerSecretStore.ServerSecretStore, {
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
    } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
    Layer.succeed(HttpClient.HttpClient, client),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    VoiceProxy.layerRoute.pipe(Layer.provideMerge(services)),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const issue = () => Effect.runPromise(VoiceProxy.issueVoiceAccessUrl().pipe(Effect.provide(services)));
  return { handler, forwarded, issue };
};

describe("voice proxy", () => {
  it("forwards a signed request to the voice service with the link token", async () => {
    const { handler, forwarded, issue } = fixture();
    const { relativeUrl } = await issue();
    const response = await handler(
      new Request(`http://t3.test${relativeUrl}/v1/jobs/voice-1`, {
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
    const { handler, forwarded, issue } = fixture();
    const { relativeUrl } = await issue();
    const tampered = `${relativeUrl?.slice(0, -2)}xx/v1/info`;
    expect((await handler(new Request(`http://t3.test${tampered}`))).status).toBe(404);
    expect((await handler(new Request(`http://t3.test${relativeUrl}/v1/../admin`))).status).toBe(
      404,
    );
    expect(forwarded).toEqual([]);
  });

  it("offers no access without a voice service sending into this environment", async () => {
    expect(await fixture(null).issue()).toEqual({ relativeUrl: null });
    expect(await fixture({ ...LINK, environmentId: "env-other" }).issue()).toEqual({
      relativeUrl: null,
    });
  });
});
