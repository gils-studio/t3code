export type VoiceUpload = {
  readonly id: string;
  readonly audioUri: string;
  readonly metaUri: string;
  readonly url: string;
  readonly token: string;
};

export const voiceUploadSupported = false;

export function enqueueVoiceUpload(_upload: VoiceUpload): void {}

export type VoiceDeliveryNotice = { readonly title: string; readonly text: string };

/** Keeps the app alive with a notification while a sent recording still needs this phone. */
export function showVoiceDelivery(_notice: VoiceDeliveryNotice | null): void {}
