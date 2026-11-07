import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { authorShelfKey, resolveTeamPeople, TOGETHER_AUTHOR_SHELF } from "./messageAuthors";

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled !== false;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;

  const people = loaded ? resolveTeamPeople(preferencesResult.value).join("\n") : "";
  const authorShelves = useMemo(() => {
    const names = people === "" ? [] : people.split("\n");
    return [
      ...names.map((name) => ({ key: authorShelfKey(name), label: name })),
      ...(names.length > 1 ? [{ key: TOGETHER_AUTHOR_SHELF, label: "Together" }] : []),
    ];
  }, [people]);
  const collapsed = loaded ? (preferencesResult.value.threadListCollapsedAuthorShelves ?? []) : [];
  const collapsedKey = collapsed.join("\n");
  const collapsedAuthorShelves = useMemo(
    () => new Set(collapsedKey === "" ? [] : collapsedKey.split("\n")),
    [collapsedKey],
  );

  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  const toggleAuthorShelf = (key: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const shelves = current.threadListCollapsedAuthorShelves ?? [];
        return {
          threadListCollapsedAuthorShelves: shelves.includes(key)
            ? shelves.filter((shelf) => shelf !== key)
            : [...shelves, key],
        };
      },
    });
  };

  return {
    loaded,
    authorShelves,
    collapsedAuthorShelves,
    toggleAuthorShelf,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
