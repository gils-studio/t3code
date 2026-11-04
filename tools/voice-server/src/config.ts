import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type Config = {
  readonly port: number;
  /** SHA-256 hashes of device tokens; the tokens themselves are never stored here. */
  readonly tokenHashes: ReadonlyArray<string>;
  /** Token hash to the person who owns that phone; agents read the name in the voice marker. */
  readonly speakers?: Readonly<Record<string, string>>;
  readonly publicUrl: string;
  /** Subdomain on the sish tunnel host; null keeps the service on loopback only. */
  readonly tunnelName: string | null;
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

const readConfigNow = () => JSON.parse(NodeFS.readFileSync(configPath(), "utf8")) as Config;

/** Read per request, so a phone paired while the service runs works at once. */
export const readTokenHashes = (): ReadonlyArray<string> => readConfigNow().tokenHashes;

export const readSpeakers = (): Readonly<Record<string, string>> => readConfigNow().speakers ?? {};

export async function writeConfig(config: Config): Promise<void> {
  const temporary = `${configPath()}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify(config, null, 2));
  await NodeFSP.rename(temporary, configPath());
}
