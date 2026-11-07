import { normalizeMessageAuthor } from "@t3tools/client-runtime/user-message";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom } from "./preferences";

/** The name this device signs its messages and recordings with, if one is set. */
export function currentMessageAuthorName(): string | undefined {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? normalizeMessageAuthor(preferences.value.messageAuthorName)
    : undefined;
}
