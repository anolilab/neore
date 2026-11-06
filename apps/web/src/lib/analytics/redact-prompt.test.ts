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
        expect(redacted?.properties.$current_url).toBe("https://app.example.com/chat?model=gpt-4o");
        expect(redacted?.properties.$pathname).toBe("/chat");
        expect(redacted?.properties.distinct_id).toBe("user-1");
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

    it("drops a session-replay snapshot that records a prompt link's href, rather than sending it", () => {
        const event = {
            event: "$snapshot",
            properties: {
                $snapshot_data: [
                    { data: { href: linkOpened }, type: 4 },
                    { data: { source: 0 }, type: 3 },
                ],
            },
        };

        expect(redactPromptFromEvent(event)).toBeNull();
    });

    it("does not change the event it was given", () => {
        const event = { event: "$pageview", properties: { $current_url: linkOpened } };

        redactPromptFromEvent(event);

        expect(event.properties.$current_url).toBe(linkOpened);
    });
});

/** The path and query a link opens, as a sign-in return URL records them (`openedFrom`, `redirectTo`). */
const linkPath = ((): string => {
    const { pathname, search } = new URL(linkOpened);

    return `${pathname}${search}`;
})();

/** A sign-in page's URL carrying the link as its `redirectTo`, written the way the sign-in view writes it. */
const signInPage = (returnPath: string): string => {
    const page = new URL("https://app.example.com/auth/sign-in");

    page.searchParams.set("redirectTo", returnPath);

    return page.href;
};

describe("a prompt link on a sign-in route", () => {
    it("keeps the prompt text out of the sign-in page's URL, where the return link is nested encoded", () => {
        const cleaned = redactPromptFromUrl(signInPage(linkPath));

        expect(cleaned).not.toContain("Summarise");
        expect(cleaned).not.toContain("merger");
        expect(cleaned).toBe("https://app.example.com/auth/sign-in?redirectTo=%2Fchat%3Fmodel%3Dgpt-4o");
    });

    it("keeps the prompt text out when the return link is encoded twice", () => {
        const twice = new URL("https://app.example.com/auth/sign-in");

        twice.searchParams.set("redirectTo", signInPage(linkPath));

        expect(redactPromptFromUrl(twice.href)).not.toContain("merger");
    });

    it("keeps the prompt text out of a pageview on the sign-in route, from the page URL and the referrer", () => {
        const event = {
            event: "$pageview",
            properties: { $current_url: signInPage(linkPath), $pathname: "/auth/sign-in", $referrer: linkOpened },
        };

        const payload = JSON.stringify(redactPromptFromEvent(event));

        expect(payload).not.toContain("Summarise");
        expect(payload).not.toContain("merger");
        expect(payload).toContain("/auth/sign-in");
    });
});

describe("the exact sign-in inputs from the review", () => {
    it.each([
        ["relative", "/auth/sign-in?redirectTo=%2Fchat%3Fprompt%3D%2522hi%2522", "/auth/sign-in?redirectTo=%2Fchat"],
        [
            "absolute",
            "https://app.example.com/auth/sign-in?redirectTo=%2Fchat%3Fprompt%3D%2522hi%2522",
            "https://app.example.com/auth/sign-in?redirectTo=%2Fchat",
        ],
        [
            "email code, with the model after",
            "/auth/email-otp?redirectTo=%2Fchat%3Fprompt%3D%2522hi%2522&model=x",
            "/auth/email-otp?redirectTo=%2Fchat&model=x",
        ],
    ])("removes the nested prompt from a %s sign-in URL", (_name, input, expected) => {
        expect(redactPromptFromUrl(input)).toBe(expected);
    });
});

describe("a session recording snapshot of a prompt link", () => {
    it("is dropped when its page URL names the prompt, so no compressed part of it is sent", () => {
        const snapshot = {
            event: "$snapshot",
            properties: {
                $current_url: linkOpened,
                $snapshot_bytes: 1200,
                $snapshot_data: { data: "H4sIAAAAAAAAA...compressed...", type: 2 },
            },
        };

        expect(redactPromptFromEvent(snapshot)).toBeNull();
    });

    it("is dropped when a plain part of it, the meta event's href, names the prompt", () => {
        const snapshot = {
            event: "$snapshot",
            properties: {
                $current_url: "https://app.example.com/chat",
                $snapshot_data: [{ data: { href: linkOpened, height: 800, width: 1200 }, type: 4 }],
            },
        };

        expect(redactPromptFromEvent(snapshot)).toBeNull();
    });

    it("keeps a snapshot of a page that names no prompt, unchanged", () => {
        const snapshot = {
            event: "$snapshot",
            properties: {
                $current_url: "https://app.example.com/chat?model=gpt-4o",
                $snapshot_data: [{ data: { href: "https://app.example.com/chat?model=gpt-4o", type: 4 }, type: 4 }],
            },
        };

        expect(redactPromptFromEvent(snapshot)).toEqual(snapshot);
    });
});

describe("what the scrubber keeps", () => {
    it("keeps every other query parameter and the fragment, byte for byte", () => {
        expect(redactPromptFromUrl("/chat?prompt=hi&model=gpt-4o&q=a%20b+c#notes")).toBe("/chat?model=gpt-4o&q=a%20b+c#notes");
        expect(redactPromptFromUrl("/auth/sign-in?lang=en%20US&redirectTo=%2Fchat%3Fprompt%3Dhi&theme=dark#section?x")).toBe(
            "/auth/sign-in?lang=en%20US&redirectTo=%2Fchat&theme=dark#section?x",
        );
    });

    it("keeps a value that merely contains prompt=, as a note does (the review's example)", () => {
        expect(redactPromptFromUrl("/chat?note=prompt=keep&model=gpt-4o")).toBe("/chat?note=prompt=keep&model=gpt-4o");
    });

    it("drops the fragment only when the fragment held nothing else", () => {
        expect(redactPromptFromUrl("/chat?prompt=hi#prompt=hi")).toBe("/chat");
    });
});

describe("the event's own fields", () => {
    it("keeps a Date timestamp as a Date, with its time", () => {
        const timestamp = new Date("2026-11-06T10:00:00.000Z");
        const redacted = redactPromptFromEvent({ event: "$pageview", properties: { $current_url: linkOpened }, timestamp });

        expect(redacted?.timestamp).toBeInstanceOf(Date);
        expect(redacted?.timestamp.getTime()).toBe(timestamp.getTime());
    });

    it("returns the same event object when it names no prompt, so nothing is copied", () => {
        const event = { event: "$pageview", properties: { $current_url: "https://app.example.com/chat?model=gpt-4o" }, timestamp: new Date() };

        expect(redactPromptFromEvent(event)).toBe(event);
    });
});

describe("an encoded top-level prompt in an analytics URL", () => {
    it.each([
        ["an encoded key, p as %70", "https://app.example.com/chat?%70rompt=hi&model=gpt-4o"],
        ["an encoded equals sign", "https://app.example.com/chat?prompt%3Dhi&model=gpt-4o"],
        ["an encoded key in capitals", "https://app.example.com/chat?%50ROMPT%3Dhi&model=gpt-4o"],
        ["a key encoded twice", "https://app.example.com/chat?%2570rompt%253Dhi&model=gpt-4o"],
        ["a value encoded as a quoted string", "https://app.example.com/chat?prompt=%22hi%22&model=gpt-4o"],
        ["every letter of the key encoded", "https://app.example.com/chat?model=gpt-4o&%70%72%6F%6D%70%74=hi"],
    ])("removes the prompt from a URL with %s, and keeps the model", (_name, url) => {
        const cleaned = redactPromptFromUrl(url);

        expect(cleaned).not.toContain("hi");
        expect(cleaned).toBe("https://app.example.com/chat?model=gpt-4o");
    });
});
