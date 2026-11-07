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
});
