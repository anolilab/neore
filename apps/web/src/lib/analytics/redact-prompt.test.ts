import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";

import { redactPromptFromEvent } from "./redact-prompt";

/** Words of the nested test's prompt, none of which may reach the event. */
const PROMPT_WORDS = /secret|more|end/u;

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

    it("removes the text of a nested link whose separator is encoded but whose = is not", () => {
        const event = redactPromptFromEvent(pageView({ $current_url: "https://app.test/auth/sign-in?redirectTo=%2Fchat%3Fprompt=my+secret%26model%3Dgpt" }));

        expect(event?.properties.$current_url).toBe("https://app.test/auth/sign-in?redirectTo=%2Fchat%3Fprompt=redacted%26model%3Dgpt");
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

    it("redacts a prompt parameter whose name is percent-encoded, in an address and in a nested one", () => {
        const nested = encodeURIComponent("/chat?%70rompt=private text");
        const event = redactPromptFromEvent(
            pageView({ $current_url: "https://app.test/chat?%70rompt=private%20text", $referrer: `https://app.test/auth/sign-in?redirectTo=${nested}` }),
        );

        expect(JSON.stringify(event)).not.toContain("private");
    });

    it("redacts a link nested through two sign-in redirects, keeping the parameters around it", () => {
        const inner = `/auth/sign-in?redirectTo=${encodeURIComponent("/chat?prompt=my secret%20%26 more %23 end&model=gpt")}`;
        const event = redactPromptFromEvent(pageView({ $current_url: `https://app.test/auth/sign-in?redirectTo=${encodeURIComponent(inner)}&x=1` }));

        // The prompt's own `&` and `#` are one layer deeper than the link's, so the whole text goes, not just its start.
        expect(JSON.stringify(event)).not.toMatch(PROMPT_WORDS);
        expect(event?.properties.$current_url).toContain("model%253Dgpt");
        expect(event?.properties.$current_url).toContain("&x=1");
    });
});
