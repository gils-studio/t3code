/**
 * An agent's question or approval waits while the user is still composing: a
 * dictation into this composer runs, or the draft holds a message that is not
 * sent yet. Once opened (by hand or by showing up) it stays over a draft, but
 * never covers a running dictation.
 */
export function isPendingRequestHeldBack(input: {
  readonly requestId: string | null;
  readonly openedRequestId: string | null;
  readonly dictatingHere: boolean;
  readonly draftHasMessage: boolean;
}): boolean {
  if (input.requestId === null) return false;
  if (input.dictatingHere) return true;
  return input.draftHasMessage && input.openedRequestId !== input.requestId;
}
