import { describe, expect, it, vi } from "vite-plus/test";

import {
  VoiceOutbox,
  type VoiceJob,
  type VoiceOutboxDependencies,
  type VoiceOutboxItem,
  type VoiceOutboxStore,
  type VoiceServerClient,
} from "./voiceOutbox";

function harness(options: { readonly saved?: ReadonlyArray<VoiceOutboxItem> } = {}) {
  const stored = new Map((options.saved ?? []).map((item) => [item.id, item]));
  const missingAudio = new Set<string>();
  const store: VoiceOutboxStore = {
    list: async () => [...stored.values()],
    save: async (item) => void stored.set(item.id, item),
    remove: async (id) => void stored.delete(id),
    adoptAudio: async (item) => !missingAudio.has(item.sourceUri ?? ""),
  };
  const jobs = new Map<string, VoiceJob>();
  const client = {
    enqueueUpload: vi.fn<VoiceServerClient["enqueueUpload"]>(),
    fetchJob: vi.fn<VoiceServerClient["fetchJob"]>(async (id) => jobs.get(id) ?? null),
    acknowledge: vi.fn<VoiceServerClient["acknowledge"]>(async () => {}),
    retry: vi.fn<VoiceServerClient["retry"]>(async () => {}),
    claim: vi.fn<VoiceServerClient["claim"]>(async () => "claimed"),
  };
  const drafts = new Map<string, string>();
  const appendDraft = vi.fn(async (ownerKey: string, text: string) => {
    drafts.set(ownerKey, `${drafts.get(ownerKey) ?? ""}${text}`);
  });
  let sequence = 0;
  const live = { start: vi.fn(), stop: vi.fn(), getText: () => "gehoert" };
  const heldMessages = {
    release: vi.fn<VoiceOutboxDependencies["heldMessages"]["release"]>(async () => true),
    remove: vi.fn<VoiceOutboxDependencies["heldMessages"]["remove"]>(async () => {}),
    setSteering: vi.fn<VoiceOutboxDependencies["heldMessages"]["setSteering"]>(async () => true),
  };
  const startThread = vi.fn<VoiceOutboxDependencies["startThread"]>();
  const submitDraft = vi.fn<(ownerKey: string) => void>();
  const outbox = new VoiceOutbox({
    store,
    getClient: () => client,
    appendDraft,
    submitDraft,
    startThread,
    heldMessages,
    live,
    newId: () => `voice-${(sequence += 1)}`,
    language: () => "de",
    now: () => sequence,
  });
  let draftText = "typed";
  const handoff = outbox.createHandoff({
    ownerKey: "owner",
    threadId: "thread",
    sendsThroughDraft: () => false,
    readDraftText: () => draftText,
    clearDraftText: () => {
      draftText = "";
    },
  });
  const finish = async (disposition: "draft" | "send") => {
    handoff.recordingStarted("file:///cache/a.aac");
    handoff.recordingFinished("file:///cache/a.aac", disposition);
    await outbox.poll();
  };
  const done = (transcript: string): VoiceJob => ({
    status: "done",
    transcript,
    queuePosition: null,
    lastError: null,
  });
  return {
    outbox,
    stored,
    jobs,
    client,
    drafts,
    appendDraft,
    submitDraft,
    startThread,
    heldMessages,
    handoff,
    finish,
    done,
    missingAudio,
    readDraftText: () => draftText,
  };
}

const item = (overrides: Partial<VoiceOutboxItem>): VoiceOutboxItem => ({
  id: "voice-1",
  ownerKey: "owner",
  threadId: "thread",
  mode: "draft",
  submitDraft: false,
  prefixText: "",
  language: "de",
  sourceUri: null,
  phase: "uploading",
  remoteStatus: null,
  queuePosition: null,
  error: null,
  createdAt: 1,
  ...overrides,
});

describe("VoiceOutbox", () => {
  it("stores typed text with a sent recording before clearing the draft", async () => {
    const h = harness();
    await h.finish("send");
    expect(h.stored.get("voice-1")).toMatchObject({
      mode: "send",
      prefixText: "typed",
      phase: "uploading",
      sourceUri: null,
    });
    expect(h.readDraftText()).toBe("");
    expect(h.client.enqueueUpload).toHaveBeenCalled();
  });

  it("forgets a sent recording only after the server finished it", async () => {
    const h = harness();
    await h.finish("send");
    h.jobs.set("voice-1", { ...h.done(""), status: "transcribing" });
    await h.outbox.poll();
    expect(h.stored.get("voice-1")?.phase).toBe("processing");

    h.jobs.set("voice-1", h.done("hallo"));
    await h.outbox.poll();
    expect(h.stored.size).toBe(0);
    expect(h.appendDraft).not.toHaveBeenCalled();
  });

  it("a voice message in a new chat lands in the draft, then asks the composer to send", async () => {
    const h = harness();
    const handoff = h.outbox.createHandoff({
      ownerKey: "new-chat",
      threadId: null,
      sendsThroughDraft: () => false,
      readDraftText: () => "typed",
      clearDraftText: () => {
        throw new Error("the draft stays until the composer sends it");
      },
    });
    handoff.recordingStarted("file:///cache/a.aac");
    handoff.recordingFinished("file:///cache/a.aac", "send");
    await h.outbox.poll();
    h.jobs.set("voice-1", { ...h.done(""), status: "transcribing" });
    await h.outbox.poll();
    expect(h.submitDraft).not.toHaveBeenCalled();

    h.jobs.set("voice-1", h.done("hallo"));
    await h.outbox.poll();
    expect(h.drafts.get("new-chat")).toBe("hallo");
    expect(h.submitDraft).toHaveBeenCalledWith("new-chat");
  });

  describe("a recording sent from a new chat", () => {
    const held = {
      environmentId: "env",
      threadId: "new-thread",
      messageId: "message",
      draftKey: "new-chat",
      sendsAlone: false,
    };
    const sendFromNewChat = async () => {
      const h = harness();
      const handoff = h.outbox.createHandoff({
        ownerKey: "new-chat",
        threadId: null,
        sendsThroughDraft: () => false,
        readDraftText: () => "",
        clearDraftText: () => {},
      });
      handoff.recordingStarted("file:///cache/a.aac");
      handoff.recordingFinished("file:///cache/a.aac", "send");
      await h.outbox.poll();
      return h;
    };
    const holdIt = async (prefixText = "") => {
      const h = await sendFromNewChat();
      const enqueue = vi.fn(async () => {});
      const hold = () =>
        h.outbox.holdThreadMessage("voice-1", held, "thread-key", prefixText, enqueue);
      expect(await hold()).toBe(true);
      return { ...h, enqueue };
    };

    it("keeps fetching a held transcript after the app was put away, but nothing else", async () => {
      vi.useFakeTimers();
      try {
        const h = await holdIt();
        h.outbox.setForeground(false);
        h.client.fetchJob.mockClear();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.client.fetchJob).toHaveBeenCalledWith("voice-1");

        const other = await sendFromNewChat();
        other.outbox.setForeground(true);
        other.outbox.setForeground(false);
        other.client.fetchJob.mockClear();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(other.client.fetchJob).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("asks the screen to open the chat, with the words heard so far", async () => {
      const h = await sendFromNewChat();
      expect(h.startThread).toHaveBeenCalledWith("new-chat", "voice-1", "gehoert");
    });

    it("releases the message with the transcript instead of touching a draft", async () => {
      const h = await holdIt("typed");
      expect(h.stored.get("voice-1")).toMatchObject({ ownerKey: "thread-key", heldMessage: held });
      h.jobs.set("voice-1", h.done("hallo"));
      await h.outbox.poll();
      expect(h.heldMessages.release).toHaveBeenCalledWith(held, "typed\n\nhallo");
      expect(h.appendDraft).not.toHaveBeenCalled();
      expect(h.submitDraft).not.toHaveBeenCalled();
      expect(h.stored.size).toBe(0);
    });

    it("keeps the recording until the release is stored", async () => {
      const h = await holdIt();
      h.heldMessages.release.mockRejectedValueOnce(new Error("disk full"));
      h.jobs.set("voice-1", h.done("hallo"));
      await h.outbox.poll();
      expect(h.client.acknowledge).not.toHaveBeenCalled();
      expect(h.stored.has("voice-1")).toBe(true);
    });

    it("puts the text into the draft when the chat was deleted meanwhile", async () => {
      const h = await holdIt();
      h.heldMessages.release.mockResolvedValueOnce(false);
      h.jobs.set("voice-1", h.done("hallo"));
      await h.outbox.poll();
      expect(h.drafts.get("new-chat")).toBe("hallo");
    });

    it("does not repeat the text when a crash follows the release", async () => {
      const h = await holdIt();
      h.heldMessages.release.mockImplementationOnce(async () => {
        throw new Error("killed");
      });
      h.jobs.set("voice-1", h.done("hallo"));
      await h.outbox.poll();
      h.heldMessages.release.mockResolvedValueOnce(false);
      await h.outbox.poll();
      expect(h.appendDraft).not.toHaveBeenCalled();
      expect(h.stored.size).toBe(0);
    });

    it("sends the typed text or image when the recording held no speech", async () => {
      const h = await sendFromNewChat();
      const alone = { ...held, sendsAlone: true };
      await h.outbox.holdThreadMessage("voice-1", alone, "thread-key", "", async () => {});
      h.jobs.set("voice-1", h.done(""));
      await h.outbox.poll();
      expect(h.heldMessages.release).toHaveBeenCalledWith(alone, "");
      expect(h.heldMessages.remove).not.toHaveBeenCalled();
      expect(h.stored.size).toBe(0);
    });

    it("shows silence in the chat, and dismissing it removes the empty chat", async () => {
      const h = await holdIt();
      h.jobs.set("voice-1", h.done(""));
      await h.outbox.poll();
      expect(h.stored.get("voice-1")?.phase).toBe("no-speech");
      await h.outbox.dismiss("voice-1");
      expect(h.heldMessages.remove).toHaveBeenCalledWith(held);
      expect(h.stored.size).toBe(0);
    });

    it("never removes an image with the failed recording it waited for", async () => {
      const h = await sendFromNewChat();
      const alone = { ...held, sendsAlone: true };
      await h.outbox.holdThreadMessage("voice-1", alone, "thread-key", "", async () => {});
      h.jobs.set("voice-1", { ...h.done(""), status: "failed", lastError: "broken" });
      await h.outbox.poll();
      await h.outbox.dismiss("voice-1");
      expect(h.heldMessages.remove).not.toHaveBeenCalled();
      expect(h.heldMessages.release).toHaveBeenCalledWith(alone, "");
    });

    it("refuses a recording that already went through the draft", async () => {
      const h = await sendFromNewChat();
      h.jobs.set("voice-1", h.done("hallo"));
      await h.outbox.poll();
      const enqueue = vi.fn(async () => {});
      expect(await h.outbox.holdThreadMessage("voice-1", held, "thread-key", "", enqueue)).toBe(
        false,
      );
      expect(enqueue).not.toHaveBeenCalled();
    });

    it("stays on the draft path when the message could not be stored", async () => {
      const h = await sendFromNewChat();
      const failing = async () => {
        throw new Error("disk full");
      };
      await expect(
        h.outbox.holdThreadMessage("voice-1", held, "thread-key", "", failing),
      ).rejects.toThrow("disk full");
      expect(h.stored.get("voice-1")).toMatchObject({ ownerKey: "new-chat", submitDraft: true });
    });
  });

  describe("steering a recording the service would send", () => {
    const held = {
      environmentId: "env",
      threadId: "thread",
      messageId: "message-1",
      draftKey: "owner",
      sendsAlone: false,
    };
    const start = async (claim?: Awaited<ReturnType<VoiceServerClient["claim"]>>) => {
      const h = harness();
      if (claim) h.client.claim.mockResolvedValue(claim);
      await h.finish("send");
      const enqueueMessage = vi.fn(async () => {});
      const steer = (steers: boolean) =>
        h.outbox.setSteering("voice-1", steers, () => ({ held, enqueueMessage }));
      return { ...h, enqueueMessage, steer, saved: () => h.stored.get("voice-1") };
    };

    it("takes the job from the service and delivers the transcript itself", async () => {
      const h = await start();
      await h.steer(true);
      expect(h.enqueueMessage).toHaveBeenCalledOnce();
      expect(h.saved()).toMatchObject({ mode: "draft", heldMessage: { steers: true } });
      h.jobs.set("voice-1", h.done("Wort"));
      await h.outbox.poll();
      expect(h.heldMessages.release).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "message-1" }),
        "typed\n\nWort",
      );
    });

    it("drops its message when the service had already started sending", async () => {
      const h = await start("too-late");
      await h.steer(true);
      expect(h.heldMessages.remove).toHaveBeenCalledOnce();
      expect(h.saved()).toMatchObject({ mode: "send" });
      expect(h.saved()?.heldMessage).toBeUndefined();
    });

    it("claims on the next poll when the service could not be asked yet", async () => {
      const h = await start("missing");
      await h.steer(true);
      expect(h.saved()).toMatchObject({ mode: "send" });
      h.client.claim.mockResolvedValue("claimed");
      await h.outbox.poll();
      expect(h.saved()).toMatchObject({ mode: "draft" });
    });

    it("undo keeps the message on the phone and only stops it from steering", async () => {
      const h = await start();
      await h.steer(true);
      await h.steer(false);
      expect(h.heldMessages.setSteering).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "message-1" }),
        false,
      );
      expect(h.heldMessages.remove).not.toHaveBeenCalled();
      expect(h.saved()).toMatchObject({ mode: "draft", heldMessage: { steers: false } });
      expect(h.client.claim).toHaveBeenCalledOnce();
    });

    it("leaves the service in charge when the message could not be stored", async () => {
      const h = await start();
      h.enqueueMessage.mockRejectedValue(new Error("disk full"));
      await expect(h.steer(true)).rejects.toThrow("disk full");
      expect(h.client.claim).not.toHaveBeenCalled();
      expect(h.saved()?.heldMessage).toBeUndefined();
    });
  });

  describe("a message sent while its dictation is transcribing", () => {
    const held = {
      environmentId: "env",
      threadId: "thread",
      messageId: "message",
      draftKey: "owner",
      sendsAlone: true,
    };

    it("finds the recording and waits for its words", async () => {
      const h = harness();
      await h.finish("draft");
      expect(h.outbox.pendingDraftItemId("owner")).toBe("voice-1");
      await h.outbox.holdThreadMessage("voice-1", held, "owner", "typed", async () => {});
      expect(h.outbox.pendingDraftItemId("owner")).toBe(null);
      h.jobs.set("voice-1", h.done("hallo"));
      await h.outbox.poll();
      expect(h.heldMessages.release).toHaveBeenCalledWith(held, "typed\n\nhallo");
      expect(h.appendDraft).not.toHaveBeenCalled();
    });

    it("has nothing to wait for once the words arrived", async () => {
      const h = harness();
      await h.finish("draft");
      h.jobs.set("voice-1", h.done("hallo"));
      await h.outbox.poll();
      expect(h.outbox.pendingDraftItemId("owner")).toBe(null);
    });

    it("sends a recording with attachments through the draft, not the service", async () => {
      const h = harness();
      const handoff = h.outbox.createHandoff({
        ownerKey: "owner",
        threadId: "thread",
        sendsThroughDraft: () => true,
        readDraftText: () => "typed",
        clearDraftText: () => {
          throw new Error("the composer sends the draft");
        },
      });
      handoff.recordingStarted("file:///cache/a.aac");
      handoff.recordingFinished("file:///cache/a.aac", "send");
      await h.outbox.poll();
      expect(h.stored.get("voice-1")).toMatchObject({ mode: "draft", submitDraft: true });
      expect(h.startThread).toHaveBeenCalledWith("owner", "voice-1", "gehoert");
    });
  });

  it("keeps the item when the draft could not take the text", async () => {
    const h = harness();
    await h.finish("draft");
    h.jobs.set("voice-1", h.done("hallo"));
    h.appendDraft.mockRejectedValueOnce(new Error("storage busy"));
    await h.outbox.poll();
    expect(h.stored.has("voice-1")).toBe(true);
    expect(h.client.acknowledge).not.toHaveBeenCalled();

    await h.outbox.poll();
    expect(h.drafts.get("owner")).toBe("hallo");
    expect(h.stored.size).toBe(0);
  });

  it("turns a recording cut off by a crash into a draft job", async () => {
    const h = harness({
      saved: [item({ phase: "recording", mode: "send", sourceUri: "file:///cache/a.aac" })],
    });
    await h.outbox.recover();
    expect(h.stored.get("voice-1")).toMatchObject({ mode: "draft", phase: "uploading" });
    expect(h.client.enqueueUpload).toHaveBeenCalledTimes(2);
  });

  it("uploads again when the server does not know a processed recording", async () => {
    const h = harness({ saved: [item({ phase: "processing" })] });
    await h.outbox.recover();
    await h.outbox.poll();
    expect(h.client.enqueueUpload).toHaveBeenCalled();
    expect(h.stored.get("voice-1")?.phase).toBe("uploading");
  });

  it("returns typed text to the draft when a sent recording held no speech", async () => {
    const h = harness();
    await h.finish("send");
    h.jobs.set("voice-1", h.done("  "));
    await h.outbox.poll();
    expect(h.drafts.get("owner")).toBe("typed");
    expect(h.stored.get("voice-1")).toMatchObject({ phase: "no-speech", prefixText: "" });
  });

  it("keeps a failed recording until it is retried or dismissed", async () => {
    const h = harness();
    await h.finish("send");
    h.jobs.set("voice-1", { ...h.done(""), status: "failed", lastError: "gpu" });
    await h.outbox.poll();
    expect(h.stored.get("voice-1")).toMatchObject({ phase: "failed", error: "gpu" });

    await h.outbox.retry("voice-1");
    expect(h.client.retry).toHaveBeenCalledWith("voice-1");
    expect(h.stored.get("voice-1")?.phase).toBe("processing");

    await h.outbox.poll();
    await h.outbox.dismiss("voice-1");
    expect(h.drafts.get("owner")).toBe("typed");
    expect(h.stored.size).toBe(0);
  });

  it("reports a recording whose file is gone and keeps the typed text", async () => {
    const h = harness();
    h.missingAudio.add("file:///cache/a.aac");
    await h.finish("send");
    expect(h.stored.get("voice-1")).toMatchObject({ phase: "failed", prefixText: "typed" });
    expect(h.client.enqueueUpload).not.toHaveBeenCalled();
  });

  it("removes a cancelled recording", async () => {
    const h = harness();
    h.handoff.recordingStarted("file:///cache/a.aac");
    h.handoff.recordingDiscarded("file:///cache/a.aac");
    await h.outbox.poll();
    expect(h.stored.size).toBe(0);
  });

  it("sends nothing for a draft without a thread", async () => {
    const h = harness();
    const handoff = h.outbox.createHandoff({
      ownerKey: "new-task",
      threadId: null,
      sendsThroughDraft: () => false,
      readDraftText: () => "typed",
      clearDraftText: () => {
        throw new Error("the draft must stay");
      },
    });
    handoff.recordingStarted("file:///cache/a.aac");
    handoff.recordingFinished("file:///cache/a.aac", "send");
    await h.outbox.poll();
    expect(h.stored.get("voice-1")?.mode).toBe("draft");
  });
});
