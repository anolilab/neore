import { createHash } from "node:crypto";

import { setupI18n } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";

import appSignInRefusal from "./app-sign-in-refusal";

// The unit-test transform does not compile Lingui macros, so `msg` is mocked with the id Lingui's extractor gives a
// placeholder-free message (the first six base64url characters of its SHA-256).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            const message = strings.join("");
            const id = createHash("sha256").update(`${message}\u{1F}`).digest("base64url").slice(0, 6);

            return { id, message };
        },
    };
});

const IMPERSONATING_MESSAGE = "Apps can't be signed in while impersonating. Sign in as yourself to connect one.";
const FALLBACK = "The extension could not be connected.";

/** An i18n whose catalog translates every message it is handed, so a translated line is told apart from the backend's. */
const translating = (...messages: string[]) => {
    const i18n = setupI18n();
    const catalog = Object.fromEntries(
        messages.map((message) => [createHash("sha256").update(`${message}\u{1F}`).digest("base64url").slice(0, 6), `[de] ${message}`]),
    );

    i18n.loadAndActivate({ locale: "de", messages: catalog });

    return i18n;
};

describe(appSignInRefusal, () => {
    const i18n = translating(IMPERSONATING_MESSAGE, FALLBACK);

    it("words the impersonation refusal in the user's language, not the backend's English", () => {
        expect(appSignInRefusal({ error: "access_denied", message: IMPERSONATING_MESSAGE, reason: "impersonating" }, i18n)).toBe(
            `[de] ${IMPERSONATING_MESSAGE}`,
        );
    });

    it("shows the backend's message for another refusal that shares the code", () => {
        expect(appSignInRefusal({ error: "access_denied", message: "This account is suspended." }, i18n)).toBe("This account is suspended.");
        expect(appSignInRefusal({ error: "invalid_request", message: "Malformed request body.", reason: "impersonating" }, i18n)).toBe(
            "Malformed request body.",
        );
    });

    it("falls back to the generic line when the body carries no message", () => {
        expect(appSignInRefusal({ error: "server_error" }, i18n)).toBe(`[de] ${FALLBACK}`);
        expect(appSignInRefusal({}, i18n)).toBe(`[de] ${FALLBACK}`);
    });
});
