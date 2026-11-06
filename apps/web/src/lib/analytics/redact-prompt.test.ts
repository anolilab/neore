import { describe, expect, it } from "vitest";

import { buildPromptLink } from "@/features/chat/core/utils/prompt-link";

import { redactPromptFromEvent, redactPromptFromUrl } from "./redact-prompt";

const SECRET = "Summarise the confidential merger plan";

/** The link a copied message makes, as the page URL of the new chat it opens. */
const linkOpened = buildPromptLink("https://app.example.com", { model: "gpt-4o", prompt: SECRET });

describe(redactPromptFromUrl, () => {
    it("removes the prompt parameter and keeps the model", () => {
        expect(redactPromptFromUrl(linkOpened)).toBe("https://app.example.com/chat?model=gpt-4o");
    });

    it("removes the prompt from a path and query, and from the middle or end of the query", () => {
        expect(redactPromptFromUrl("/chat?prompt=secret&model=gpt-4o")).toBe("/chat?model=gpt-4o");
        expect(redactPromptFromUrl("/chat?model=gpt-4o&prompt=secret")).toBe("/chat?model=gpt-4o");
        expect(redactPromptFromUrl("/chat?prompt=secret")).toBe("/chat");
        expect(redactPromptFromUrl("/chat?prompt=secret#notes")).toBe("/chat#notes");
    });

    it("leaves a value without a prompt parameter unchanged", () => {
        expect(redactPromptFromUrl("https://app.example.com/chat?model=gpt-4o")).toBe("https://app.example.com/chat?model=gpt-4o");
        expect(redactPromptFromUrl("")).toBe("");
    });
});

describe(redactPromptFromEvent, () => {
    it("keeps the prompt text out of a page view's current URL and referrer", () => {
        const event = {
            event: "$pageview",
            properties: {
                $current_url: linkOpened,
                $referrer: linkOpened,
                $pathname: "/chat",
                distinct_id: "user-1",
            },
            uuid: "00000000-0000-4000-8000-000000000000",
        };

        const redacted = redactPromptFromEvent(event);
        const payload = JSON.stringify(redacted);

        expect(payload).not.toContain(SECRET);
        expect(payload).not.toContain("confidential");
        expect(redacted.properties.$current_url).toBe("https://app.example.com/chat?model=gpt-4o");
        expect(redacted.properties.$pathname).toBe("/chat");
        expect(redacted.properties.distinct_id).toBe("user-1");
    });

    it("keeps the prompt text out of an error report's URL, wherever the report puts it", () => {
        const event = {
            event: "$exception",
            properties: {
                $exception_message: "boom",
                url: linkOpened,
                $set: { $initial_current_url: linkOpened },
            },
        };

        const payload = JSON.stringify(redactPromptFromEvent(event));

        expect(payload).not.toContain(SECRET);
        expect(payload).toContain("boom");
    });

    it("keeps the prompt text out of a session-replay snapshot, which records the page's href", () => {
        const event = {
            event: "$snapshot",
            properties: {
                $snapshot_data: [
                    { data: { href: linkOpened }, type: 4 },
                    { data: { source: 0 }, type: 3 },
                ],
            },
        };

        const payload = JSON.stringify(redactPromptFromEvent(event));

        expect(payload).not.toContain(SECRET);
        expect(payload).toContain('"type":3');
    });

    it("does not change the event it was given", () => {
        const event = { event: "$pageview", properties: { $current_url: linkOpened } };

        redactPromptFromEvent(event);

        expect(event.properties.$current_url).toBe(linkOpened);
    });
});
