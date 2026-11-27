import { describe, expect, it } from "vitest";

import { pickNextPrompt } from "./next-prompt";

const cached = { lastMessageId: "reply-2", suggestions: ["Add a test for it", "Something else"] };

const input = { cached, enabled: true, isRunning: false, lastReplyId: "reply-2" };

describe(pickNextPrompt, () => {
    it("offers the first suggestion, for the newest reply", () => {
        expect(pickNextPrompt(input)).toBe("Add a test for it");
    });

    it("offers nothing with the setting off", () => {
        expect(pickNextPrompt({ ...input, enabled: false })).toBeNull();
    });

    it("offers nothing while the chat is still running", () => {
        expect(pickNextPrompt({ ...input, isRunning: true })).toBeNull();
    });

    it("never offers a suggestion made for an older reply", () => {
        expect(pickNextPrompt({ ...input, lastReplyId: "reply-3" })).toBeNull();
    });

    it("offers nothing when no reply answers something the person wrote", () => {
        expect(pickNextPrompt({ ...input, lastReplyId: undefined })).toBeNull();
    });

    it("offers nothing when nothing is cached, or the cache is empty or blank", () => {
        expect(pickNextPrompt({ ...input, cached: null })).toBeNull();
        expect(pickNextPrompt({ ...input, cached: { lastMessageId: "reply-2", suggestions: [] } })).toBeNull();
        expect(pickNextPrompt({ ...input, cached: { lastMessageId: "reply-2", suggestions: [" ".repeat(3)] } })).toBeNull();
    });
});
