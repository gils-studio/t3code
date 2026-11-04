import { describe, expect, it, vi } from "vite-plus/test";

import { VoiceLivePreview, voiceLiveTail, type VoiceLiveClient } from "./voiceLivePreview";

function harness() {
  const audio = { bytes: new Uint8Array(0) };
  const sendLiveAudio = vi.fn<VoiceLiveClient["sendLiveAudio"]>(async (_id, offset, bytes) => ({
    received: offset + bytes.length,
    text: `heard ${offset}`,
  }));
  const preview = new VoiceLivePreview({
    getClient: () => ({ sendLiveAudio }),
    readAudio: async (_uri, offset) => audio.bytes.subarray(offset),
  });
  return { audio, preview, sendLiveAudio };
}

describe("VoiceLivePreview", () => {
  it("wakes the server at once, then sends only what the recorder added", async () => {
    vi.useFakeTimers();
    const { audio, preview, sendLiveAudio } = harness();
    preview.start("voice-1", "file:///a.aac", "de");
    await vi.advanceTimersByTimeAsync(0);
    expect(sendLiveAudio.mock.calls[0]?.slice(0, 2)).toEqual(["voice-1", 0]);

    audio.bytes = new Uint8Array(5);
    await vi.advanceTimersByTimeAsync(1_000);
    audio.bytes = new Uint8Array(8);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendLiveAudio.mock.calls.map(([, offset, bytes]) => [offset, bytes.length])).toEqual([
      [0, 0],
      [0, 5],
      [5, 3],
    ]);
    expect(preview.getText()).toBe("heard 5");
    preview.stop();
    vi.useRealTimers();
  });

  it("resumes where the server says after it lost track", async () => {
    vi.useFakeTimers();
    const { audio, preview, sendLiveAudio } = harness();
    audio.bytes = new Uint8Array(9);
    sendLiveAudio.mockResolvedValueOnce({ received: 2, text: "" });
    preview.start("voice-1", "file:///a.aac", "de");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendLiveAudio.mock.calls[1]?.[1]).toBe(2);
    expect(sendLiveAudio.mock.calls[1]?.[2].length).toBe(7);
    preview.stop();
    vi.useRealTimers();
  });

  it("keeps trying after a failure and goes quiet once stopped", async () => {
    vi.useFakeTimers();
    const { preview, sendLiveAudio } = harness();
    sendLiveAudio.mockRejectedValueOnce(new Error("offline"));
    preview.start("voice-1", "file:///a.aac", "de");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(preview.getText()).toBe("heard 0");

    preview.stop();
    const calls = sendLiveAudio.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendLiveAudio.mock.calls.length).toBe(calls);
    expect(preview.getText()).toBe("");
    vi.useRealTimers();
  });

  it("ignores an answer that arrives after the recording stopped", async () => {
    const { preview, sendLiveAudio } = harness();
    let answer = (_value: { received: number; text: string }) => {};
    sendLiveAudio.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    preview.start("voice-1", "file:///a.aac", "de");
    await vi.waitFor(() => expect(sendLiveAudio).toHaveBeenCalled());
    preview.stop();
    answer({ received: 0, text: "late" });
    await Promise.resolve();
    expect(preview.getText()).toBe("");
  });
});

describe("voiceLiveTail", () => {
  it("keeps short text and cuts long text at a word", () => {
    expect(voiceLiveTail("kurz")).toBe("kurz");
    const tail = voiceLiveTail(`${"wort ".repeat(40)}ende`);
    expect(tail.startsWith("…wort")).toBe(true);
    expect(tail.endsWith("ende")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(121);
  });
});
