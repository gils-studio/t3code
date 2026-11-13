import { requireOptionalNativeModule } from "expo";
import { AppRegistry } from "react-native";

import type { VoiceDeliveryNotice, VoiceUpload } from "./voiceUpload";

type VoiceUploadModule = {
  enqueueUpload(id: string, audioUri: string, metaUri: string, url: string, token: string): void;
  // Missing in native builds from before the delivery service.
  showDelivery?(title: string, text: string): boolean;
  hideDelivery?(): void;
};

const native = requireOptionalNativeModule<VoiceUploadModule>("T3VoiceTranscription");

export const voiceUploadSupported = native !== null;

export function enqueueVoiceUpload(upload: VoiceUpload): void {
  native?.enqueueUpload(upload.id, upload.audioUri, upload.metaUri, upload.url, upload.token);
}

const deliveryTaskEnds = new Set<() => void>();

// The native delivery runs this while a recording needs the phone: an open task keeps JS timers,
// and with them the outbox polling, running with the app in the background.
AppRegistry.registerHeadlessTask(
  "T3VoiceDelivery",
  () => () => new Promise<void>((resolve) => void deliveryTaskEnds.add(resolve)),
);

export function showVoiceDelivery(notice: VoiceDeliveryNotice | null): void {
  if (notice) {
    native?.showDelivery?.(notice.title, notice.text);
    return;
  }
  native?.hideDelivery?.();
  for (const end of deliveryTaskEnds) end();
  deliveryTaskEnds.clear();
}
