import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import type { VoiceOutboxItem } from "./voiceOutbox";
import { useVoiceOutboxItems, voiceOutbox } from "./voiceOutboxRuntime";
import { voiceItemLabel } from "./voiceThreadMessages";

/** Where a recording stands, with the ways out once it stopped by itself. */
export function VoiceItemStatus(props: {
  readonly item: VoiceOutboxItem;
  readonly compact?: boolean;
}) {
  const { item, compact = false } = props;
  const settled = item.phase === "no-speech" || item.phase === "failed";
  const textSize = compact ? "text-xs" : "text-sm";
  return (
    <View className={cn("min-w-0 shrink flex-row items-center", compact ? "gap-1.5" : "gap-2")}>
      {settled ? null : <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />}
      <Text
        accessibilityLiveRegion="polite"
        className={cn(
          "min-w-0 shrink font-t3-medium",
          textSize,
          item.phase === "failed" ? "text-danger-foreground" : "text-foreground-muted",
        )}
        numberOfLines={2}
      >
        {voiceItemLabel(item)}
      </Text>
      {item.phase === "failed" ? (
        <Pressable
          accessibilityRole="button"
          className="min-h-7 justify-center px-1 active:opacity-70"
          hitSlop={8}
          onPress={() => void voiceOutbox.retry(item.id)}
        >
          <Text className={cn("font-medium text-foreground", textSize)}>Retry</Text>
        </Pressable>
      ) : null}
      {settled ? (
        <Pressable
          accessibilityLabel="Dismiss recording"
          accessibilityRole="button"
          className="size-7 items-center justify-center active:opacity-70"
          hitSlop={8}
          onPress={() => void voiceOutbox.dismiss(item.id)}
        >
          <SymbolView
            name="xmark"
            size={12}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Stands in for the "Pending" of a chat row that still waits for its words. */
export function VoiceMessageStatus(props: { readonly voiceId: string }) {
  const item = useVoiceOutboxItems().find((candidate) => candidate.id === props.voiceId);
  return item ? <VoiceItemStatus compact item={item} /> : null;
}
