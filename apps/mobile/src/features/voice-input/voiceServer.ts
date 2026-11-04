import * as SecureStore from "expo-secure-store";

import { enqueueVoiceUpload } from "../../native/voiceUpload";
import type { VoiceJob, VoiceServerClient } from "./voiceOutbox";
import { voiceOutboxAudioFile, voiceOutboxMetaFile } from "./voiceOutboxStore";

const VOICE_SERVER_STORAGE_KEY = "t3code.voice-server";
const PAIR_LINK = /^t3code(?:-dev|-preview)?:\/\/voice-pair\?(.*)$/;

export type VoiceServerConfig = {
  readonly url: string;
  readonly token: string;
  /** Sending needs this environment: the service reaches only the T3 server on its own machine. */
  readonly environmentId: string;
};

export const isVoicePairLink = (link: string) => PAIR_LINK.test(link.trim());

export function parseVoicePairLink(
  link: string,
): { readonly url: string; readonly token: string } | null {
  const query = PAIR_LINK.exec(link.trim())?.[1];
  if (!query) return null;
  const values = new Map(
    query.split("&").map((part) => {
      const separator = part.indexOf("=");
      return [
        part.slice(0, separator),
        decodeURIComponent(part.slice(separator + 1).replaceAll("+", " ")),
      ] as const;
    }),
  );
  const url = values.get("url")?.replace(/\/+$/, "");
  const token = values.get("token");
  return url && token && /^https?:\/\//.test(url) ? { url, token } : null;
}

export async function readVoiceServerConfig(): Promise<VoiceServerConfig | null> {
  const stored = await SecureStore.getItemAsync(VOICE_SERVER_STORAGE_KEY);
  return stored ? (JSON.parse(stored) as VoiceServerConfig) : null;
}

export const writeVoiceServerConfig = (config: VoiceServerConfig) =>
  SecureStore.setItemAsync(VOICE_SERVER_STORAGE_KEY, JSON.stringify(config));

export const deleteVoiceServerConfig = () => SecureStore.deleteItemAsync(VOICE_SERVER_STORAGE_KEY);

const authorization = (token: string) => ({ authorization: `Bearer ${token}` });

export async function fetchVoiceServerConfig(pairing: {
  readonly url: string;
  readonly token: string;
}): Promise<VoiceServerConfig> {
  const response = await fetch(`${pairing.url}/v1/info`, {
    headers: authorization(pairing.token),
  });
  if (!response.ok) throw new Error(`The voice server answered with ${response.status}.`);
  const info = (await response.json()) as { readonly environmentId: string };
  return { ...pairing, environmentId: info.environmentId };
}

export function createVoiceServerClient(config: VoiceServerConfig): VoiceServerClient {
  const post = async (id: string, action: "ack" | "retry") => {
    const response = await fetch(`${config.url}/v1/jobs/${id}/${action}`, {
      method: "POST",
      headers: authorization(config.token),
    });
    if (!response.ok) throw new Error(`Voice server ${action} failed: ${response.status}`);
  };
  return {
    enqueueUpload: (item) =>
      enqueueVoiceUpload({
        id: item.id,
        audioUri: voiceOutboxAudioFile(item.id).uri,
        metaUri: voiceOutboxMetaFile(item.id).uri,
        url: `${config.url}/v1/jobs/${item.id}`,
        token: config.token,
      }),
    fetchJob: async (id) => {
      const response = await fetch(`${config.url}/v1/jobs/${id}`, {
        headers: authorization(config.token),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Voice server status failed: ${response.status}`);
      return (await response.json()) as VoiceJob;
    },
    acknowledge: (id) => post(id, "ack"),
    retry: (id) => post(id, "retry"),
  };
}
