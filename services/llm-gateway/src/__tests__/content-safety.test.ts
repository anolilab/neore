/**
 * Unit tests for middleware/content-safety.ts.
 *
 * This middleware is a live security control on every `/internal/*` endpoint
 * that accepts user text, and it had no tests at all. The cases below pin the
 * three things that are easy to break without noticing:
 *
 *  - WHICH text is scanned. Only `user` messages and `system` are user-authored;
 *    assistant and tool content is model output and is deliberately skipped.
 *    Widening that would let a model's own echo of a blocked term 400 the
 *    conversation; narrowing it would let `system` through unchecked.
 *  - WHERE the text lives. `/internal/model/proxy` nests the prompt under
 *    `callOptions.prompt`, everything else uses `messages`/`system`. Those are
 *    two separate extraction paths and only one is exercised by any given route.
 *  - That the response does NOT echo the matched words. Returning them would let
 *    any caller reaching this handler reconstruct the wordlist a few requests at
 *    a time.
 */
import { getThreadTitlePrompt } from "@neore/ai/prompts";
import { BANNED_WORDS } from "@visulima/content-safety";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contentSafetyMiddleware, CROSS_LANGUAGE_ALLOWLIST } from "../middleware/content-safety.js";

// "damn" is flagged by `@visulima/content-safety`; deliberately the mildest term
// that trips the filter, so these tests need nothing stronger.
const BANNED = "damn";

const makeApp = () => {
    const app = new Hono();

    app.use("*", contentSafetyMiddleware);
    app.all("*", (c) => c.json({ reached: true }));

    return app;
};

const post = async (path: string, body: unknown) =>
    makeApp().request(path, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });

describe("contentSafetyMiddleware — what it scans", () => {
    it("blocks a banned word in a plain-string user message", async () => {
        const res = await post("/internal/generate", { messages: [{ content: `this is ${BANNED}`, role: "user" }] });

        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("BANNED_CONTENT");
    });

    it("blocks a banned word inside an array content text part", async () => {
        const res = await post("/internal/generate", {
            messages: [{ content: [{ text: `this is ${BANNED}`, type: "text" }], role: "user" }],
        });

        expect(res.status).toBe(400);
    });

    it("blocks a banned word in `system`", async () => {
        const res = await post("/internal/generate", { messages: [], system: `be ${BANNED} helpful` });

        expect(res.status).toBe(400);
    });

    it("does NOT block model-authored content — assistant messages are not scanned", async () => {
        const res = await post("/internal/generate", { messages: [{ content: `this is ${BANNED}`, role: "assistant" }] });

        expect(res.status).toBe(200);
    });

    it("ignores non-text parts in array content", async () => {
        const res = await post("/internal/generate", {
            messages: [{ content: [{ image: `${BANNED}.png`, type: "image" }], role: "user" }],
        });

        expect(res.status).toBe(200);
    });

    it("allows clean text through", async () => {
        const res = await post("/internal/generate", { messages: [{ content: "hello world", role: "user" }] });

        expect(res.status).toBe(200);
        expect(((await res.json()) as { reached: boolean }).reached).toBe(true);
    });
});

describe("contentSafetyMiddleware — the model-proxy extraction path", () => {
    it("blocks a banned word nested under callOptions.prompt", async () => {
        const res = await post("/internal/model/proxy", {
            callOptions: { prompt: [{ content: `this is ${BANNED}`, role: "user" }] },
        });

        expect(res.status).toBe(400);
    });

    it("does not read `messages` on the proxy route — only callOptions is scanned there", async () => {
        // Same banned text, wrong field for this route: the proxy branch reads
        // `callOptions.prompt` and nothing else, so this passes through.
        const res = await post("/internal/model/proxy", { messages: [{ content: `this is ${BANNED}`, role: "user" }] });

        expect(res.status).toBe(200);
    });

    it("passes through when callOptions.prompt is not an array", async () => {
        const res = await post("/internal/model/proxy", { callOptions: { prompt: BANNED } });

        expect(res.status).toBe(200);
    });
});

describe("contentSafetyMiddleware — scope and failure modes", () => {
    it("ignores non-POST requests", async () => {
        const res = await makeApp().request("/internal/generate", { method: "GET" });

        expect(res.status).toBe(200);
    });

    it("ignores paths outside /internal/", async () => {
        const res = await post("/v1/chat", { messages: [{ content: `this is ${BANNED}`, role: "user" }] });

        expect(res.status).toBe(200);
    });

    it("passes through on an unparseable body rather than failing the request", async () => {
        const res = await makeApp().request("/internal/generate", {
            body: "not json",
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });

        expect(res.status).toBe(200);
    });

    it("passes through when there is no text to check", async () => {
        const res = await post("/internal/generate", { messages: [] });

        expect(res.status).toBe(200);
    });
});

describe("contentSafetyMiddleware — does not leak the wordlist", () => {
    it("omits the matched words from the response body", async () => {
        const res = await post("/internal/generate", { messages: [{ content: `this is ${BANNED}`, role: "user" }] });
        const raw = await res.text();

        expect(res.status).toBe(400);
        // The whole point: an HMAC-authed caller must not be able to probe for
        // banned terms by reading them back out of the rejection.
        expect(raw).not.toContain(BANNED);
        expect(raw).not.toContain("matches");
    });
});

describe("contentSafetyMiddleware — cross-language false positives", () => {
    // Every language list is scanned at once, so a foreign entry spelled like an
    // English word blocked plain English — including this product's own name.
    const BENIGN = "Reply with exactly the word: pong";

    afterEach(() => {
        vi.useRealTimers();
    });

    it("passes the benign prompt in the exact shape createTitleChat sends", async () => {
        // createTitleChat (backend/lunora/chat/functions.ts) puts the title
        // template — which says "chat" — into a USER message, and French lists
        // "chat". This is the request that returned BANNED_CONTENT.
        const prompt = `${getThreadTitlePrompt("Europe/Berlin", "Berlin", "en")}\nHere is the user's prompt:\n"${BENIGN}"\nGenerate a title that accurately represents what this conversation is about based on the prompt provided.`;

        const res = await post("/internal/model/proxy", {
            callOptions: {
                prompt: [
                    { content: "You are a helpful assistant.", role: "system" },
                    { content: [{ text: prompt, type: "text" }], role: "user" },
                ],
            },
        });

        expect(res.status).toBe(200);
    });

    // The title prompt carries the local time, and zh lists "13." and ko "18":
    // without the allowlist this request failed for two hours every day.
    it.each(["2026-10-01T11:04:00Z", "2026-10-01T16:30:00Z", "2026-03-13T12:00:00Z"])(
        "passes the title prompt built at %s (13:xx / 18:xx Berlin, the 13th)",
        async (now) => {
            vi.useFakeTimers({ now: new Date(now), toFake: ["Date"] });

            const res = await post("/internal/model/proxy", {
                callOptions: { prompt: [{ content: getThreadTitlePrompt("Europe/Berlin", "Berlin", "en"), role: "user" }] },
            });

            expect(res.status).toBe(200);
        },
    );

    it.each(["I am 18", "13. Oktober"])("passes the numeral in %j", async (text) => {
        const res = await post("/internal/model/proxy", { callOptions: { prompt: [{ content: text, role: "user" }] } });

        expect(res.status).toBe(200);
    });

    it("still blocks the English numeric hate codes", async () => {
        const res = await post("/internal/model/proxy", { callOptions: { prompt: [{ content: "1488", role: "user" }] } });

        expect(res.status).toBe(400);
    });

    it.each(["What does this do?", "I got it", "build a chat app", "a video game", "fresh air"])("passes %j", async (text) => {
        const res = await post("/internal/model/proxy", { callOptions: { prompt: [{ content: text, role: "user" }] } });

        expect(res.status).toBe(200);
    });

    it("still blocks a real banned word next to an allowlisted one", async () => {
        const res = await post("/internal/model/proxy", {
            callOptions: { prompt: [{ content: `build a chat app, ${BANNED}`, role: "user" }] },
        });

        expect(res.status).toBe(400);
    });

    it("allowlists nothing the English list itself bans", () => {
        const english = new Set(BANNED_WORDS.en!.map((word) => word.toLowerCase()));

        expect(CROSS_LANGUAGE_ALLOWLIST.filter((word) => english.has(word))).toEqual([]);
    });
});
