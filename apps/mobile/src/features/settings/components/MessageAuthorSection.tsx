import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { normalizeMessageAuthor } from "@t3tools/client-runtime/user-message";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { parseTeamMemberNames } from "../../threads/messageAuthors";
import { SettingsSection } from "./SettingsSection";

const INPUT_CLASS_NAME =
  "min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground";

export function MessageAuthorSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferences)) return null;
  const name = preferences.value.messageAuthorName ?? "";
  const others = (preferences.value.teamMemberNames ?? []).join(", ");
  // Remounting on a stored change keeps the fields' drafts without syncing them in an effect.
  return <MessageAuthorFields key={`${name}\n${others}`} name={name} others={others} />;
}

function MessageAuthorFields(props: { readonly name: string; readonly others: string }) {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [name, setName] = useState(props.name);
  const [others, setOthers] = useState(props.others);

  const saveName = () => {
    const normalized = normalizeMessageAuthor(name) ?? "";
    if (normalized === props.name) return;
    savePreferences(
      normalized === "" ? { messageAuthorName: undefined } : { messageAuthorName: normalized },
    );
  };
  const saveOthers = () => {
    const names = parseTeamMemberNames(others);
    if (names.join(", ") === props.others) return;
    savePreferences({ teamMemberNames: names });
  };

  return (
    <>
      <SettingsSection title="Messages">
        <View className="gap-3 p-4">
          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Your name</Text>
            <AppTextInput
              accessibilityLabel="Your name"
              autoCorrect={false}
              className={INPUT_CLASS_NAME}
              onBlur={saveName}
              onChangeText={setName}
              onSubmitEditing={saveName}
              placeholder="Gerrit"
              returnKeyType="done"
              value={name}
            />
          </View>
          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">Others on the team</Text>
            <AppTextInput
              accessibilityLabel="Others on the team"
              autoCorrect={false}
              className={INPUT_CLASS_NAME}
              onBlur={saveOthers}
              onChangeText={setOthers}
              onSubmitEditing={saveOthers}
              placeholder="Nils"
              returnKeyType="done"
              value={others}
            />
          </View>
        </View>
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Messages and recordings you send from this device carry your name, so agents know who is
        talking and everyone sees it under the message. The thread list groups threads by who wrote
        in them. Separate several names with commas.
      </Text>
    </>
  );
}
