/** What a connected environment said about its voice service; "unknown" when it could not say. */
export type VoiceAccessAnswer =
  | { readonly url: string }
  | { readonly url: null }
  | "unknown";

type VoiceServerChoice = { readonly url: string; readonly environmentId: string };

/**
 * The phone keeps one voice service. An environment that offers one replaces the current choice
 * unless that one is still connected; only the chosen environment can take it away again, and a
 * failed lookup changes nothing, so a flaky connection never drops a working service.
 */
export function chooseVoiceServer(
  current: VoiceServerChoice | null,
  environmentId: string,
  answer: VoiceAccessAnswer,
  connectedEnvironmentIds: ReadonlyArray<string>,
): VoiceServerChoice | null {
  if (answer === "unknown") return current;
  if (answer.url === null) return current?.environmentId === environmentId ? null : current;
  if (
    current === null ||
    current.environmentId === environmentId ||
    !connectedEnvironmentIds.includes(current.environmentId)
  ) {
    return { url: answer.url, environmentId };
  }
  return current;
}
