import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";

import { redactPromptFromEvent } from "./redact-prompt";

const pageView = (properties: CaptureResult["properties"]): CaptureResult => ({ event: "$pageview", properties, uuid: "event" }) as CaptureResult;

describe(redactPromptFromEvent, () => {
    it("removes a prompt link's text from the page URL and keeps the rest of the address", () => {
        const event = redactPromptFromEvent(pageView({ $current_url: "https://app.test/chat?prompt=my+secret+%26+more&model=gpt#top" }));

        expect(event?.properties.$current_url).toBe("https://app.test/chat?prompt=redacted&model=gpt#top");
    });

    it("removes the text of a link nested in a sign-in page's return address", () => {
        const nested = encodeURIComponent("/chat?prompt=my secret & more&model=gpt");
        const event = redactPromptFromEvent(pageView({ $set_once: { $initial_current_url: `https://app.test/auth/sign-in?redirectTo=${nested}` } }));

        expect(JSON.stringify(event)).not.toContain("secret");
        expect(JSON.stringify(event)).toContain("model%3Dgpt");
    });

    it("removes the text from heatmap data, which is filed under the page address", () => {
        const event = redactPromptFromEvent({
            event: "$$heatmap",
            properties: { $heatmap_data: { "https://app.test/chat?prompt=first": [{ x: 1 }], "https://app.test/chat?prompt=second": [{ x: 2 }] } },
            uuid: "event",
        } as CaptureResult);

        // Both pages' points are kept under the one redacted address.
        expect(event?.properties.$heatmap_data).toStrictEqual({ "https://app.test/chat?prompt=redacted": [{ x: 1 }, { x: 2 }] });
    });

    it("ends the redaction at the quote around an autocaptured link, keeping the rest of the element chain", () => {
        const event = redactPromptFromEvent(pageView({ $elements_chain: 'a:attr__href="/chat?prompt=hi"nth-child="1";div.card:nth-child="2"' }));

        expect(event?.properties.$elements_chain).toBe('a:attr__href="/chat?prompt=redacted"nth-child="1";div.card:nth-child="2"');
    });

    it("redacts past an apostrophe or a space, which a link written in a message can hold raw", () => {
        const event = redactPromptFromEvent(pageView({ $elements_chain: `a:attr__href="/chat?prompt=Don't share my salary"` }));

        expect(event?.properties.$elements_chain).toBe('a:attr__href="/chat?prompt=redacted"');
    });
});
