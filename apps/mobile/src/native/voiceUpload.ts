export type VoiceUpload = {
  readonly id: string;
  readonly audioUri: string;
  readonly metaUri: string;
  readonly url: string;
  readonly token: string;
};

export const voiceUploadSupported = false;

export function enqueueVoiceUpload(_upload: VoiceUpload): void {}
