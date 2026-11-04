import { describe, expect, it, vi } from "vite-plus/test";

import {
  VoiceOutbox,
  type VoiceJob,
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
  };
  const drafts = new Map<string, string>();
  const appendDraft = vi.fn(async (ownerKey: string, text: string) => {
    drafts.set(ownerKey, `${drafts.get(ownerKey) ?? ""}${text}`);
  });
  let sequence = 0;
  const outbox = new VoiceOutbox({
    store,
    getClient: () => client,
    appendDraft,
    newId: () => `voice-${(sequence += 1)}`,
    language: () => "de",
    now: () => sequence,
  });
  let draftText = "typed";
  const handoff = outbox.createHandoff({
    ownerKey: "owner",
    threadId: "thread",
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
