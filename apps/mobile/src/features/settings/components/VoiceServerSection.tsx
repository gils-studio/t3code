import { EnvironmentId } from "@t3tools/contracts";

import { AppText as Text } from "../../../components/ui/AppText";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { voiceUploadSupported } from "../../../native/voiceUpload";
import { useEnvironmentPresentation } from "../../../state/presentation";
import { useVoiceServer } from "../../voice-input/voiceOutboxRuntime";
import { SettingsSection } from "./SettingsSection";

export function VoiceServerSection() {
  const server = useVoiceServer();
  const { presentation } = useEnvironmentPresentation(
    server ? EnvironmentId.make(server.environmentId) : null,
  );

  if (!voiceUploadSupported) return null;

  return (
    <>
      <SettingsSection title="Voice server">
        {server ? (
          <ListRowLayout
            icon="desktopcomputer"
            label="Transcribing on your computer"
            description={presentation?.entry.target.label ?? "Connected environment"}
          />
        ) : (
          <ListRowLayout icon="desktopcomputer" label="No voice server found" />
        )}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        A computer running the T3 Code voice server transcribes your recordings. The app finds it
        through your connection to T3 Code on that computer. Recordings are kept until the text has
        arrived, even if you close the app, and you can send a message while still recording.
      </Text>
    </>
  );
}
