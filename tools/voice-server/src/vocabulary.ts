import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { dataDirectory } from "./config.ts";

export type Corrections = Readonly<Record<string, ReadonlyArray<string>>>;

export type Vocabulary = {
  /** Text whisper continues from. A sentence steers it better than a bare list of names. */
  readonly prompt: string;
  /** Right spelling, then what whisper writes instead. For names the prompt cannot fix. */
  readonly corrections: Corrections;
};

const NO_VOCABULARY: Vocabulary = { prompt: "", corrections: {} };

export const vocabularyPath = (): string => NodePath.join(dataDirectory(), "vocabulary.json");

/** Read per request, so a new word works at once. A broken file must never cost a recording. */
export function readVocabulary(): Vocabulary {
  try {
    const { prompt, corrections } = JSON.parse(
      NodeFS.readFileSync(vocabularyPath(), "utf8"),
    ) as Partial<Vocabulary>;
    return { prompt: prompt ?? "", corrections: corrections ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`ignoring ${vocabularyPath()}: ${String(error)}`);
    }
    return NO_VOCABULARY;
  }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole words only: "Pidor" becomes "Pidohr", also in "Pidor-App", but no word contains it. */
export function applyCorrections(text: string, corrections: Corrections): string {
  const rightSpelling = new Map(
    Object.entries(corrections).flatMap(([right, heard]) =>
      heard.map((variant) => [variant.toLowerCase(), right] as const),
    ),
  );
  if (rightSpelling.size === 0) return text;
  const variants = [...rightSpelling.keys()]
    .toSorted((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${variants.join("|")})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  return text.replace(pattern, (match) => rightSpelling.get(match.toLowerCase()) ?? match);
}

export const correctTranscript = (text: string): string =>
  applyCorrections(text, readVocabulary().corrections);
