import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import { writeFileAtomically } from "../../lib/atomic-file";
import { enqueueVoiceUpload } from "../../native/voiceUpload";
import type { VoiceLiveClient } from "./voiceLivePreview";
import type { VoiceJob, VoiceServerClient } from "./voiceOutbox";
import { voiceOutboxAudioFile, voiceOutboxMetaFile } from "./voiceOutboxStore";

const VOICE_SERVER_STORAGE_KEY = "t3code.voice-server";

/** Reached through the T3 server's `/api/voice` proxy; the URL carries its own access token. */
export type VoiceServerConfig = {
  readonly url: string;
  /** Sending needs this environment: the service reaches only the T3 server on its own machine. */
  readonly environmentId: string;
};

const isVoiceServerConfig = (value: unknown): value is VoiceServerConfig =>
  typeof value === "object" &&
  value !== null &&
  "url" in value &&
  typeof value.url === "string" &&
  "environmentId" in value &&
  typeof value.environmentId === "string" &&
  // A paired config from before the proxy still holds a device token.
  !("token" in value);

export async function readVoiceServerConfig(): Promise<VoiceServerConfig | null> {
  const stored = await SecureStore.getItemAsync(VOICE_SERVER_STORAGE_KEY);
  const config: unknown = stored ? JSON.parse(stored) : null;
  return isVoiceServerConfig(config) ? config : null;
}

/** The background upload reads the URL from this file, so a renewed one reaches queued work. */
const voiceEndpointFile = () => new File(Paths.document, "voice-endpoint");

export async function writeVoiceServerConfig(config: VoiceServerConfig | null): Promise<void> {
  const endpoint = voiceEndpointFile();
  if (config) {
    await writeFileAtomically(endpoint, config.url);
    await SecureStore.setItemAsync(VOICE_SERVER_STORAGE_KEY, JSON.stringify(config));
    return;
  }
  if (endpoint.exists) endpoint.delete();
  await SecureStore.deleteItemAsync(VOICE_SERVER_STORAGE_KEY);
}

export function createVoiceServerClient(
  config: VoiceServerConfig,
): VoiceServerClient & VoiceLiveClient {
  const post = async (id: string, action: "ack" | "retry") => {
    const response = await fetch(`${config.url}/v1/jobs/${id}/${action}`, { method: "POST" });
    if (!response.ok) throw new Error(`Voice server ${action} failed: ${response.status}`);
  };
  return {
    enqueueUpload: (item) =>
      enqueueVoiceUpload({
        id: item.id,
        audioUri: voiceOutboxAudioFile(item.id).uri,
        metaUri: voiceOutboxMetaFile(item.id).uri,
        endpointUri: voiceEndpointFile().uri,
        path: `/v1/jobs/${item.id}`,
      }),
    fetchJob: async (id) => {
      const response = await fetch(`${config.url}/v1/jobs/${id}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Voice server status failed: ${response.status}`);
      return (await response.json()) as VoiceJob;
    },
    sendLiveAudio: async (id, offset, bytes, language) => {
      const query = new URLSearchParams({ offset: String(offset), language });
      const response = await fetch(`${config.url}/v1/live/${id}?${query.toString()}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      });
      // 409 carries the position to resume from, so it is an answer like any other.
      if (!response.ok && response.status !== 409) {
        throw new Error(`Voice server live audio failed: ${response.status}`);
      }
      return (await response.json()) as { readonly received: number; readonly text: string };
    },
    handOver: async (id, target) => {
      const response = await fetch(`${config.url}/v1/jobs/${id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target),
      });
      if (response.status === 404) return "missing";
      if (response.status === 409) return "too-late";
      if (!response.ok) throw new Error(`Voice server hand-over failed: ${response.status}`);
      return "handed";
    },
    acknowledge: (id) => post(id, "ack"),
    retry: (id) => post(id, "retry"),
  };
}
