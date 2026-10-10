import { createHash } from "node:crypto";

import { setupI18n } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";

import { messages as deMessages } from "../locales/de/messages.js";
import { Route } from "../routes/(public)/tutorials/index";

// The unit-test transform does not compile Lingui macros, so `msg` is mocked
// with the id Lingui's extractor gives a placeholder-free message (the first
// six base64url characters of its SHA-256), so the real German catalog
// resolves it.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            const message = strings.join("");
            const id = createHash("sha256").update(`${message}\u{1F}`).digest("base64url").slice(0, 6);

            return { id, message };
        },
    };
});

vi.mock("@/lib/env", () => {
    return { default: { VITE_SITE_URL: "https://neore.test/" } };
});

vi.mock("@/features/marketing/components/tutorials-page", () => {
    return { default: () => null };
});

type Head = (context: { match: { context: { i18n: ReturnType<typeof setupI18n> } } }) => {
    meta: ({ content?: string; name?: string; title?: string } | undefined)[];
};

describe("route head()", () => {
    it("words the tutorials title and description in the request's locale", () => {
        const i18n = setupI18n({ locale: "de", messages: { de: deMessages } });
        const head = Route.options.head as unknown as Head;
        const { meta } = head({ match: { context: { i18n } } });

        const title = meta.find((tag) => tag?.title !== undefined)?.title;
        const description = meta.find((tag) => tag?.name === "description")?.content;

        expect(title).toBe("Tutorials — Lerne Neore Chat kennen | Neore | Neore Chat");
        expect(description?.startsWith("Lerne")).toBe(true);
    });
});
