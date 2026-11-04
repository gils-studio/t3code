import { requireOptionalNativeModule } from "expo";

import type { VoiceUpload } from "./voiceUpload";

type VoiceUploadModule = {
  enqueueUpload(id: string, audioUri: string, metaUri: string, url: string, token: string): void;
};

const native = requireOptionalNativeModule<VoiceUploadModule>("T3VoiceTranscription");

export const voiceUploadSupported = native !== null;

export function enqueueVoiceUpload(upload: VoiceUpload): void {
  native?.enqueueUpload(upload.id, upload.audioUri, upload.metaUri, upload.url, upload.token);
}
