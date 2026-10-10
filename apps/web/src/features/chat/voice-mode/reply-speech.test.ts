import { describe, expect, it } from "vitest";

import type { SpeakableMessage, VoiceLike } from "./reply-speech";
import { findFinishedReply, findSkillVoice, latestAssistantId, pickVoice, promptBefore, skillSlugFromPrompt } from "./reply-speech";

const message = (id: string, role: string, status = "success", text = id): SpeakableMessage => {
    return { id, role, status, text };
};

describe(latestAssistantId, () => {
    it("finds the newest assistant message", () => {
        expect(latestAssistantId([message("a1", "assistant"), message("u1", "user"), message("a2", "assistant"), message("u2", "user")])).toBe("a2");
        expect(latestAssistantId([message("u1", "user")])).toBeNull();
    });
});

describe(findFinishedReply, () => {
    const thread = [message("u1", "user"), message("a1", "assistant"), message("u2", "user")];

    it("waits while the prompt is still the last message", () => {
        expect(findFinishedReply(thread, { baselineId: "a1", isStreaming: false })).toBeNull();
    });

    it("waits while streaming or while the reply is pending", () => {
        const withReply = [...thread, message("a2", "assistant", "success")];

        expect(findFinishedReply(withReply, { baselineId: "a1", isStreaming: true })).toBeNull();
        expect(findFinishedReply([...thread, message("a2", "assistant", "streaming")], { baselineId: "a1", isStreaming: false })).toBeNull();
        expect(findFinishedReply([...thread, message("a2", "assistant", "pending")], { baselineId: "a1", isStreaming: false })).toBeNull();
    });

    it("never returns the baseline reply", () => {
        expect(findFinishedReply(thread.slice(0, 2), { baselineId: "a1", isStreaming: false })).toBeNull();
    });

    it("returns the new reply, flagging a failed one", () => {
        expect(findFinishedReply([...thread, message("a2", "assistant")], { baselineId: "a1", isStreaming: false })).toStrictEqual({
            failed: false,
            message: message("a2", "assistant"),
        });
        expect(findFinishedReply([...thread, message("a2", "assistant", "failed")], { baselineId: "a1", isStreaming: false })?.failed).toBe(true);
    });

    it("accepts the first reply of a new thread (no baseline)", () => {
        expect(findFinishedReply([message("u1", "user"), message("a1", "assistant")], { baselineId: null, isStreaming: false })?.message.id).toBe("a1");
    });
});

describe(promptBefore, () => {
    it("finds the user message the reply answers", () => {
        const messages = [message("u1", "user"), message("a1", "assistant"), message("u2", "user"), message("a2", "assistant")];

        expect(promptBefore(messages, "a2")?.id).toBe("u2");
        expect(promptBefore(messages, "u1")).toBeNull();
        expect(promptBefore(messages, "missing")).toBeNull();
    });
});

describe(skillSlugFromPrompt, () => {
    it("reads a leading slash command", () => {
        expect(skillSlugFromPrompt("/code-reviewer check this")).toBe("code-reviewer");
        expect(skillSlugFromPrompt("  /translate")).toBe("translate");
    });

    it("ignores anything else", () => {
        expect(skillSlugFromPrompt("please /translate this")).toBeNull();
        expect(skillSlugFromPrompt("/Not-A-Slug")).toBeNull();
        expect(skillSlugFromPrompt("/path/to/file")).toBeNull();
        expect(skillSlugFromPrompt("")).toBeNull();
    });
});

describe(pickVoice, () => {
    const voices: VoiceLike[] = [
        { lang: "en-US", name: "Samantha" },
        { lang: "en-GB", name: "Daniel" },
        { default: true, lang: "de-DE", name: "Anna" },
        { lang: "de-AT", name: "Helena (Enhanced)" },
    ];

    it("prefers an exact voice name, case-insensitively", () => {
        expect(pickVoice(voices, "daniel", "de-DE")?.name).toBe("Daniel");
    });

    it("resolves a language tag", () => {
        expect(pickVoice(voices, "en-GB", undefined)?.name).toBe("Daniel");
        expect(pickVoice(voices, "de_AT", undefined)?.name).toBe("Helena (Enhanced)");
        expect(pickVoice(voices, "de", undefined)?.name).toBe("Anna");
    });

    it("matches a partial name", () => {
        expect(pickVoice(voices, "Helena", undefined)?.name).toBe("Helena (Enhanced)");
    });

    it("falls back to the reply language, then to the browser default", () => {
        expect(pickVoice(voices, "Nonexistent Voice", "en-US")?.name).toBe("Samantha");
        expect(pickVoice(voices, undefined, "fr-FR")).toBeUndefined();
        expect(pickVoice(voices, undefined, undefined)).toBeUndefined();
    });
});

describe(findSkillVoice, () => {
    const skills = [
        { id: "s1", slug: "reviewer", voice: "Daniel" },
        { id: "s2", slug: "translator", voice: "  " },
        { id: "s3", slug: "plain" },
    ];

    it("prefers the speaking participant, then the invoked slug", () => {
        expect(findSkillVoice(skills, { skillId: "s1", slug: "translator" })).toBe("Daniel");
        expect(findSkillVoice(skills, { slug: "reviewer" })).toBe("Daniel");
    });

    it("returns undefined for a blank, missing or unknown voice", () => {
        expect(findSkillVoice(skills, { slug: "translator" })).toBeUndefined();
        expect(findSkillVoice(skills, { slug: "plain" })).toBeUndefined();
        expect(findSkillVoice(skills, { skillId: "nope" })).toBeUndefined();
        expect(findSkillVoice(skills, {})).toBeUndefined();
    });
});
