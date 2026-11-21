import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type Config = {
  readonly port: number;
  readonly whisperCli: string;
  readonly whisperCwd: string;
  readonly whisperArgs: ReadonlyArray<string>;
  /** Loopback port of the model server that runs while someone dictates. */
  readonly whisperServerPort?: number;
  /** How long the model stays loaded after the last use. */
  readonly whisperIdleSeconds?: number;
  readonly vadModel?: string;
  readonly model: string;
  readonly ffmpeg: string;
  readonly t3Command: string;
};

export const dataDirectory = (): string =>
  process.env.T3_VOICE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3-voice");

export const configPath = (): string => NodePath.join(dataDirectory(), "config.json");

export async function readConfig(): Promise<Config> {
  return JSON.parse(await NodeFSP.readFile(configPath(), "utf8")) as Config;
}

/** The T3 server on this machine reads this to proxy `/api/voice` here; see VoiceProxy.ts. */
export const linkPath = (): string => NodePath.join(dataDirectory(), "t3-link.json");

export async function writeLink(link: {
  readonly url: string;
  readonly token: string;
  readonly environmentId: string;
}): Promise<void> {
  const temporary = `${linkPath()}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify(link), { mode: 0o600 });
  await NodeFSP.rename(temporary, linkPath());
}
