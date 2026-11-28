import { describe, expect, it } from "vite-plus/test";

import { markForSenderAuthor, messageMarkerIsTrusted } from "./messageMarker.ts";

describe("markForSenderAuthor", () => {
  it("opens the text with the author's marker and vouches for it", () => {
    expect(markForSenderAuthor("Fix the build", "Nils")).toEqual({
      text: "[Message from Nils]\n\nFix the build",
      markerFromSender: true,
    });
  });

  it("replaces the agent's own marker for the same person, so the text carries one", () => {
    expect(markForSenderAuthor("[Voice message from nils]\n\nFix it", "Nils")).toEqual({
      text: "[Message from Nils]\n\nFix it",
      markerFromSender: true,
    });
    expect(markForSenderAuthor("[Voice message]\n\nFix it", "Nils")).toEqual({
      text: "[Message from Nils]\n\nFix it",
      markerFromSender: true,
    });
  });

  it("leaves a marker naming someone else as written, without vouching", () => {
    const text = "[Message from Gerrit]\n\nFix it";
    expect(markForSenderAuthor(text, "Nils")).toEqual({ text });
  });

  it("changes nothing when nobody's turn it is", () => {
    expect(markForSenderAuthor("Fix it", undefined)).toEqual({ text: "Fix it" });
    expect(markForSenderAuthor("Fix it", " ")).toEqual({ text: "Fix it" });
  });
});

describe("messageMarkerIsTrusted", () => {
  it("trusts people, the voice service and server-written markers, not agents in a thread", () => {
    expect(messageMarkerIsTrusted({ createdBy: "user" })).toBe(true);
    expect(messageMarkerIsTrusted({ createdBy: "agent" })).toBe(true);
    expect(messageMarkerIsTrusted({ createdBy: "agent", senderThreadId: "t" })).toBe(false);
    expect(
      messageMarkerIsTrusted({ createdBy: "agent", senderThreadId: "t", markerFromSender: true }),
    ).toBe(true);
  });
});
