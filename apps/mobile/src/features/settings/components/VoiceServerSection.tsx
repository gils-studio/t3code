import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { voiceUploadSupported } from "../../../native/voiceUpload";
import {
  forgetVoiceServer,
  pairVoiceServer,
  useVoiceServer,
} from "../../voice-input/voiceOutboxRuntime";
import { SettingsSection } from "./SettingsSection";

export function VoiceServerSection() {
  const server = useVoiceServer();
  const [link, setLink] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!voiceUploadSupported) return null;

  const connect = () => {
    setPairing(true);
    setError(null);
    pairVoiceServer(link)
      .then(
        () => setLink(""),
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setPairing(false));
  };

  return (
    <>
      <SettingsSection title="Voice server">
        {server ? (
          <>
            <ListRowLayout icon="desktopcomputer" label="Connected" description={server.url} />
            <ListActionRow
              icon="trash"
              label="Disconnect"
              tone="danger"
              onPress={() => void forgetVoiceServer()}
            />
          </>
        ) : (
          <View className="gap-3 p-4">
            <AppTextInput
              accessibilityLabel="Voice server link"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
              editable={!pairing}
              onChangeText={setLink}
              placeholder="Paste the pairing link"
              value={link}
            />
            {error ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
            <Button
              label="Connect"
              tone="secondary"
              disabled={pairing || link.trim().length === 0}
              onPress={connect}
            />
          </View>
        )}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        With a voice server, your computer transcribes recordings. They are kept until the text has
        arrived, even if you close the app, and you can send a message while still recording.
      </Text>
    </>
  );
}
