import { Directory, File, Paths } from "expo-file-system";

import { writeFileAtomically } from "../../lib/atomic-file";
import type { VoiceOutboxItem, VoiceOutboxStore } from "./voiceOutbox";

const OUTBOX_DIRECTORY = "voice-outbox";
const ITEM_SUFFIX = ".json";

function outboxDirectory(): Directory {
  const directory = new Directory(Paths.document, OUTBOX_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

const itemFile = (id: string) => new File(outboxDirectory(), `${id}${ITEM_SUFFIX}`);

export const voiceOutboxAudioFile = (id: string) => new File(outboxDirectory(), `${id}.aac`);

/** The first line of the upload body, kept in a file for the background worker. */
export const voiceOutboxMetaFile = (id: string) => new File(outboxDirectory(), `${id}.meta`);

export const voiceOutboxFileStore: VoiceOutboxStore = {
  list: async () => {
    const items: VoiceOutboxItem[] = [];
    for (const entry of outboxDirectory().list()) {
      if (!(entry instanceof File) || !entry.name.endsWith(ITEM_SUFFIX)) continue;
      try {
        items.push(JSON.parse(await entry.text()) as VoiceOutboxItem);
      } catch {
        // An unreadable item stays on disk with its audio rather than being cleaned up.
      }
    }
    return items;
  },
  save: (item) => writeFileAtomically(itemFile(item.id), JSON.stringify(item)),
  remove: async (id) => {
    for (const file of [voiceOutboxAudioFile(id), voiceOutboxMetaFile(id), itemFile(id)]) {
      if (file.exists) file.delete();
    }
  },
  adoptAudio: async (item) => {
    const audio = voiceOutboxAudioFile(item.id);
    await writeFileAtomically(
      voiceOutboxMetaFile(item.id),
      JSON.stringify({
        mode: item.mode,
        threadId: item.threadId ?? "",
        language: item.language,
        prefixText: item.prefixText,
      }),
    );
    // A crash may land between the move and saving the item.
    if (audio.exists) return true;
    if (item.sourceUri === null) return false;
    const source = new File(item.sourceUri);
    if (!source.exists || source.size === 0) return false;
    source.moveSync(audio, { overwrite: true });
    return true;
  },
};
