import * as Schema from "effect/Schema";

export const VOICE_ROUTE_PREFIX = "/api/voice";

/** Null when this machine runs no voice service. The URL works without auth headers. */
export const VoiceAccessResult = Schema.Struct({
  relativeUrl: Schema.NullOr(Schema.String),
});
export type VoiceAccessResult = typeof VoiceAccessResult.Type;

export class VoiceAccessSigningKeyError extends Schema.TaggedError<VoiceAccessSigningKeyError>()(
  "VoiceAccessSigningKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load the voice access signing key.";
  }
}
