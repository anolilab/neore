import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { describe, expect, it } from "vitest";

import { isTokenStale, tokenExpiresAt } from "@/lib/access-token";

import { isReplyPersisted, toChatMessages, withLiveReply } from "./messages";
import { createLineBuffer } from "./stream";

const base64Url = (value: string) => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const jwt = (payload: Record<string, number>) => `${base64Url('{"alg":"EdDSA"}')}.${base64Url(JSON.stringify(payload))}.sig`;

// Line parsing itself is shared with the web app and tested in
// `packages/chat-ui/src/utils/stream-line.test.ts`.
describe("stream line buffering", () => {
    it("reassembles lines split across network chunks", () => {
        const buffer = createLineBuffer();

        /* eslint-disable unicorn/no-return-array-push -- `push` here is the line buffer's, which returns the completed lines */
        expect(buffer.push('{"text":"a"}\n{"te')).toEqual(['{"text":"a"}']);
        expect(buffer.push('xt":"b"}\n\n')).toEqual(['{"text":"b"}']);
        expect(buffer.push('{"text":"c"}')).toEqual([]);
        /* eslint-enable unicorn/no-return-array-push */
        expect(buffer.flush()).toEqual(['{"text":"c"}']);
    });
});

describe("toChatMessages", () => {
    it("sorts oldest first and keeps the page-context marker for chat-ui to render as a chip", () => {
        const pagePart = {
            providerMetadata: { neore: { pageContext: { kind: "page", title: "Docs", url: "https://example.com" } } },
            text: "wrapped page body",
            type: "text",
        };
        const messages = toChatMessages([
            { _creationTime: 2, _id: "b", parts: [{ text: "answer", type: "text" }], role: "assistant" },
            { _creationTime: 1, _id: "a", parts: [pagePart, { text: "What is this?", type: "text" }], role: "user", text: "wrapped page body\nWhat is this?" },
        ]);

        expect(messages.map((message) => message.id)).toEqual(["a", "b"]);
        expect(messages[0]!.parts[0]).toEqual(pagePart);
        expect(getVisibleUserText(messages[0]!)).toBe("What is this?");
    });

    it("leaves messages without a marker alone, even if their text looks like a wrapper", () => {
        const [message] = toChatMessages([
            {
                _creationTime: 1,
                _id: "a",
                parts: [{ text: "[Web page context] typed by hand", type: "text" }],
                role: "user",
                text: "[Web page context] typed by hand",
            },
        ]);

        expect(getVisibleUserText(message!)).toBe("[Web page context] typed by hand");
    });
});

describe("live reply merging", () => {
    const persisted = toChatMessages([
        { _creationTime: 1, _id: "prompt", parts: [{ text: "hi", type: "text" }], role: "user" },
        { _creationTime: 2, _id: "pending", parts: [], role: "assistant", status: "pending" },
    ]);

    it("shows the streamed text in place of the empty pending row", () => {
        const shown = withLiveReply(persisted, { promptMessageId: "prompt", reasoning: "", text: "Hel" });

        expect(shown.map((message) => message.id)).toEqual(["prompt", "live-prompt"]);
        expect(shown[1]!.text).toBe("Hel");
    });

    it("defers to the persisted reply once it has landed", () => {
        const done = toChatMessages([
            { _creationTime: 1, _id: "prompt", parts: [{ text: "hi", type: "text" }], role: "user" },
            { _creationTime: 2, _id: "reply", parts: [{ text: "Hello!", type: "text" }], role: "assistant", status: "success" },
        ]);

        expect(isReplyPersisted(done, { promptMessageId: "prompt" })).toBe(true);
        expect(withLiveReply(done, { promptMessageId: "prompt", reasoning: "", text: "Hello" })).toBe(done);
    });
});

describe("group chat speakers", () => {
    const writer = { name: "Writer", skillId: "skill-writer" };
    const critic = { name: "Critic", skillId: "skill-critic" };

    it("labels a persisted group reply with its participant, but not a plain reply with its model", () => {
        const [group, plain] = toChatMessages([
            { _creationTime: 1, _id: "g", agentName: "Writer", parts: [], role: "assistant", speakerSkillId: "skill-writer" },
            { _creationTime: 2, _id: "p", agentName: "gpt-5", parts: [], role: "assistant" },
        ]);

        expect(group).toMatchObject({ speakerName: "Writer", speakerSkillId: "skill-writer" });
        expect(plain!.speakerName).toBeUndefined();
    });

    it("keeps streaming the next participant after an earlier one is saved", () => {
        const afterWriter = toChatMessages([
            { _creationTime: 1, _id: "prompt", parts: [{ text: "hi", type: "text" }], role: "user" },
            {
                _creationTime: 2,
                _id: "w",
                agentName: "Writer",
                parts: [{ text: "Draft.", type: "text" }],
                role: "assistant",
                speakerSkillId: "skill-writer",
                status: "success",
            },
        ]);
        const live = { promptMessageId: "prompt", reasoning: "", speaker: critic, text: "Hm" };

        expect(isReplyPersisted(afterWriter, live)).toBe(false);
        expect(isReplyPersisted(afterWriter, { ...live, speaker: writer })).toBe(true);

        const shown = withLiveReply(afterWriter, live);

        expect(shown.map((message) => message.id)).toEqual(["prompt", "w", "live-prompt"]);
        expect(shown[2]).toMatchObject({ speakerName: "Critic", speakerSkillId: "skill-critic", text: "Hm" });
    });
});

describe("access token expiry", () => {
    it("reads exp from the JWT payload", () => {
        expect(tokenExpiresAt(jwt({ exp: 1000 }))).toBe(1_000_000);
        expect(tokenExpiresAt(jwt({}))).toBeUndefined();
        expect(tokenExpiresAt("not-a-jwt")).toBeUndefined();
    });

    it("refreshes a minute before expiry", () => {
        const token = jwt({ exp: 1000 });

        expect(isTokenStale(token, 900_000)).toBe(false);
        expect(isTokenStale(token, 950_000)).toBe(true);
    });
});
