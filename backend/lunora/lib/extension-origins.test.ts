import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OPTIONAL_ENV_KEYS } from "./env-validation";
import {
    NATIVE_REDIRECT_URI,
    parseTrustedExtensionOrigins,
    parseTrustedExtensionRedirectUris,
    SHIPPED_FIREFOX_EXTENSION_ID,
    SHIPPED_FIREFOX_REDIRECT_URI,
} from "./extension-origins";

const CHROME = `chrome-extension://${"a".repeat(32)}`;
const FIREFOX = "moz-extension://0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";

afterEach(() => {
    vi.restoreAllMocks();
});

/** Quote style is the formatter's call, so match either quote. */
const GECKO_ID_DECLARATION = /export const GECKO_ID = (["'])(?<id>[^"']+)\1/u;

describe("parseTrustedExtensionOrigins", () => {
    it("allows nothing when unset or empty", () => {
        expect(parseTrustedExtensionOrigins(undefined)).toEqual([]);
        expect(parseTrustedExtensionOrigins("")).toEqual([]);
        expect(parseTrustedExtensionOrigins(" , ,")).toEqual([]);
    });

    it("parses a comma-separated list of exact extension origins", () => {
        expect(parseTrustedExtensionOrigins(` ${CHROME}/ , ${FIREFOX},${CHROME}`)).toEqual([CHROME, FIREFOX]);
    });

    it("never widens to a wildcard, a bare scheme or a web origin", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(parseTrustedExtensionOrigins("*,chrome-extension://,chrome-extension://*,https://evil.example,chrome-extension://short")).toEqual([]);
        expect(console.warn).toHaveBeenCalledTimes(5);
    });

    it("accepts the native shell's callback only when listed, and only exactly", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        // Never a default: any app can register the `neore:` scheme.
        expect(parseTrustedExtensionRedirectUris(undefined)).not.toContain(NATIVE_REDIRECT_URI);
        expect(parseTrustedExtensionRedirectUris(`${SHIPPED_FIREFOX_REDIRECT_URI},${NATIVE_REDIRECT_URI}`)).toEqual([
            SHIPPED_FIREFOX_REDIRECT_URI,
            NATIVE_REDIRECT_URI,
        ]);
        expect(parseTrustedExtensionRedirectUris("neore://auth/callback/,neore://auth/other,neore://evil")).toEqual([]);
        expect(console.warn).toHaveBeenCalledTimes(3);
    });
});

describe("parseTrustedExtensionRedirectUris", () => {
    const FIREFOX_REDIRECT = `https://${"0a".repeat(20)}.extensions.allizom.org/`;
    const CHROME_REDIRECT = `https://${"b".repeat(32)}.chromiumapp.org/`;

    it("defaults to the shipped Firefox add-on when unset, and `none` turns it off", () => {
        expect(parseTrustedExtensionRedirectUris(undefined)).toEqual([SHIPPED_FIREFOX_REDIRECT_URI]);
        expect(parseTrustedExtensionRedirectUris("  ")).toEqual([SHIPPED_FIREFOX_REDIRECT_URI]);
        expect(parseTrustedExtensionRedirectUris("none")).toEqual([]);
        expect(parseTrustedExtensionRedirectUris(" NONE ")).toEqual([]);
    });

    it("keeps the shipped redirect URI in step with the add-on id it derives from", () => {
        // SHA-1 because that is what Firefox's `identity.getRedirectURL()` uses — an id, not a secret.
        // eslint-disable-next-line sonarjs/hashing -- reproducing the browser's derivation, not protecting anything
        const hash = createHash("sha1").update(SHIPPED_FIREFOX_EXTENSION_ID).digest("hex");

        expect(SHIPPED_FIREFOX_REDIRECT_URI).toBe(`https://${hash}.extensions.allizom.org/`);
    });

    it("is the extension's own id — GECKO_ID in the manifest", () => {
        const manifest = readFileSync(join(import.meta.dirname, "../../../apps/browser-extension/src/manifest/build-manifest.ts"), "utf8");

        const declared = GECKO_ID_DECLARATION.exec(manifest)?.groups?.id;

        expect(declared).toBe(SHIPPED_FIREFOX_EXTENSION_ID);
    });

    it("an explicit value replaces the default rather than adding to it", () => {
        expect(parseTrustedExtensionRedirectUris(CHROME_REDIRECT)).toEqual([CHROME_REDIRECT]);
    });

    it("reaches the deployed Worker: both extension vars are in the optional passthrough", () => {
        expect(OPTIONAL_ENV_KEYS).toEqual(expect.arrayContaining(["TRUSTED_EXTENSION_ORIGINS", "TRUSTED_EXTENSION_REDIRECT_URIS"]));
    });

    it("accepts browser-intercepted redirect URIs, with or without the trailing slash", () => {
        expect(parseTrustedExtensionRedirectUris(`${FIREFOX_REDIRECT.slice(0, -1)}, ${CHROME_REDIRECT},${FIREFOX_REDIRECT}`)).toEqual([
            FIREFOX_REDIRECT,
            CHROME_REDIRECT,
        ]);
    });

    it("drops anything a web page could receive", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(
            parseTrustedExtensionRedirectUris(
                [
                    "https://evil.example/",
                    `http://${"0a".repeat(20)}.extensions.allizom.org/`,
                    `https://${"0a".repeat(20)}.extensions.allizom.org.evil.example/`,
                    `https://${"0a".repeat(20)}.extensions.allizom.org/callback`,
                    "*",
                ].join(","),
            ),
        ).toEqual([]);
        expect(console.warn).toHaveBeenCalledTimes(5);
    });
});
