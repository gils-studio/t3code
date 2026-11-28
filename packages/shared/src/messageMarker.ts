const MESSAGE_MARKER =
  /^\[(?:Voice message(?: from ([^\]\r\n]+))?|Message from ([^\]\r\n]+))\]\n\n/;

/** Who a marker names and whether it marks dictation, or null for unmarked text. */
export function parseMessageMarker(text: string): {
  readonly length: number;
  readonly author: string | undefined;
  readonly voice: boolean;
} | null {
  const match = MESSAGE_MARKER.exec(text);
  if (match === null) return null;
  const author = (match[1] ?? match[2])?.trim();
  return { length: match[0].length, author: author || undefined, voice: match[2] === undefined };
}

/** A name that fits in a marker: one line, no closing bracket. */
export const normalizeMessageAuthor = (name: string | null | undefined) =>
  name?.replace(/[\]\r\n]/g, "").trim() || undefined;

/**
 * Agents in a thread always carry a sender, so only their markers are not someone's own words.
 * The voice service sends through T3's CLI, which files dictation under "agent" without a sender.
 * A marker the server wrote for the sender thread's author (`markerFromSender`) is trusted too.
 */
export const messageMarkerIsTrusted = (message: {
  readonly createdBy?: string | undefined;
  readonly senderThreadId?: string | undefined;
  readonly markerFromSender?: boolean | undefined;
}) =>
  message.createdBy !== "agent" ||
  message.senderThreadId === undefined ||
  message.markerFromSender === true;

/**
 * The text an agent sends for the person whose turn asked for it, opened with that person's
 * marker. An own marker naming the same person is replaced, so the text carries one; a marker
 * naming someone else stays as the agent wrote it and is not vouched for.
 */
export function markForSenderAuthor(
  text: string,
  author: string | undefined,
): { readonly text: string; readonly markerFromSender?: true } {
  const name = normalizeMessageAuthor(author);
  if (name === undefined) return { text };
  const marker = parseMessageMarker(text);
  if (marker?.author !== undefined && marker.author.toLowerCase() !== name.toLowerCase()) {
    return { text };
  }
  const body = marker === null ? text : text.slice(marker.length);
  return { text: `[Message from ${name}]\n\n${body}`, markerFromSender: true };
}

/** Distinct marker authors in first-seen order, compared case-insensitively. */
export function messageAuthorsOf(texts: Iterable<string>): ReadonlyArray<string> {
  const authors = new Map<string, string>();
  for (const text of texts) {
    const author = parseMessageMarker(text)?.author;
    if (author !== undefined && !authors.has(author.toLowerCase())) {
      authors.set(author.toLowerCase(), author);
    }
  }
  return [...authors.values()];
}
