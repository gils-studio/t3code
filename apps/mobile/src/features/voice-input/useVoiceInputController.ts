import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";
import { voiceOutbox } from "./voiceOutboxRuntime";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

/** Lets a composer use the voice server. Its text lives in the composer draft under ownerKey. */
export type VoiceServerTarget = {
  readonly environmentId: string;
  /** Null while the composer has no thread to send to. */
  readonly threadId: string | null;
  /** False when the draft holds what a plain text message cannot carry, such as attachments. */
  readonly canSendText: boolean;
  readonly clearDraftText: () => void;
};

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly serverTarget?: VoiceServerTarget;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const global = useGlobalVoiceInput();
  const { session } = global;
  const latestInput = useRef(input);
  // oxlint-disable-next-line react/refs -- Transcription finishes asynchronously and must reach the composer's current selection setter, not the one captured at start.
  latestInput.current = input;
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mount so async transcription results skip a composer that has unmounted
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      session.setOwnerFocused(ownerKey, true);
      return () => session.setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, session]),
  );

  const start = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled) return;
    const { ownerKey, serverTarget } = captured;
    const server = global.server;
    const handoff =
      server && serverTarget
        ? voiceOutbox.createHandoff({
            ownerKey,
            // Only the service's own environment can receive a message from it.
            threadId:
              server.environmentId === serverTarget.environmentId ? serverTarget.threadId : null,
            readDraftText: () => captured.readDraftMessage() ?? "",
            clearDraftText: serverTarget.clearDraftText,
          })
        : null;
    void session.start({
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
      handoff,
    });
  }, [global.server, session]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  const usesServer = global.server !== null && input.serverTarget !== undefined;
  return {
    isAvailable:
      (global.isAvailable || usesServer) && (!global.isBusy || global.ownerKey === input.ownerKey),
    canSend:
      usesServer &&
      input.serverTarget?.canSendText === true &&
      input.serverTarget.threadId !== null &&
      global.server?.environmentId === input.serverTarget.environmentId,
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    send: global.send,
    cancel: global.cancel,
  };
}
