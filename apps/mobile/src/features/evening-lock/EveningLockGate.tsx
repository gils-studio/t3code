import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useState } from "react";
import { AppState, View } from "react-native";

import { EmptyState } from "../../components/ui/EmptyState";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  EVENING_LOCK_UNTIL_LABEL,
  isEveningLocked,
  isEveningLockedPerson,
  nextEveningLockBoundary,
} from "./eveningLock";

/** Replaces the whole app with a lock screen while the device's person is in an evening lock. */
export function EveningLockGate(props: { readonly children: ReactNode }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const applies =
    AsyncResult.isSuccess(preferences) &&
    isEveningLockedPerson(preferences.value.messageAuthorName);
  const now = useLockClock(applies);

  if (!applies || !isEveningLocked(now)) return props.children;
  return (
    <View className="flex-1 items-center justify-center bg-screen">
      <EmptyState
        variant="plain"
        title="Off for the evening"
        detail={`T3 Code is locked on weekday evenings. It opens again at ${EVENING_LOCK_UNTIL_LABEL}.`}
      />
    </View>
  );
}

function useLockClock(enabled: boolean): Date {
  const [now, setNow] = useState(() => new Date());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the wall clock so the lock starts and ends on time, also after the app returns from the background
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      const current = new Date();
      setNow(current);
      timer = setTimeout(refresh, nextEveningLockBoundary(current).getTime() - Date.now());
    };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [enabled]);

  return now;
}
