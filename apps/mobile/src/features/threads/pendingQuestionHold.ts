import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

/**
 * A question replaces the composer, so it waits while the user is still
 * composing: a dictation into this composer runs, or the draft holds a
 * message that is not sent yet. Opening it by hand shows it over a draft,
 * never over a running dictation, whose controls it would hide.
 */
export function isPendingQuestionHeldBack(input: {
  readonly requestId: string | null;
  readonly openedRequestId: string | null;
  readonly composerKey: string | null;
  readonly voiceOwnerKey: string | null;
  readonly voiceState: VoiceInputState;
  readonly draftHasMessage: boolean;
}): boolean {
  if (input.requestId === null) return false;
  const dictatingHere =
    input.composerKey !== null &&
    input.voiceOwnerKey === input.composerKey &&
    voiceInputBlocksSubmission(input.voiceState);
  if (dictatingHere) return true;
  return input.draftHasMessage && input.openedRequestId !== input.requestId;
}
