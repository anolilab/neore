import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OPTIONAL_ENV_KEYS } from "./env-validation";
import {
    carryRetiredExtensionOrigins,
    MOBILE_REDIRECT_URI,
    NATIVE_REDIRECT_URI,
    parseTrustedExtensionRedirectUris,
    SHIPPED_FIREFOX_EXTENSION_ID,
    SHIPPED_FIREFOX_REDIRECT_URI,
} from "./extension-origins";

afterEach(() => {
    vi.restoreAllMocks();
});

/** Quote style is the formatter's call, so match either quote. */
const GECKO_ID_DECLARATION = /export const GECKO_ID = (["'])(?<id>[^"']+)\1/u;

describe("parseTrustedExtensionRedirectUris", () => {
    const FIREFOX_REDIRECT = `https://${"0a".repeat(20)}.extensions.allizom.org/`;
    const CHROME_REDIRECT = `https://${"b".repeat(32)}.chromiumapp.org/`;

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

    it("admits the mobile callback only when listed, and only exactly", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(parseTrustedExtensionRedirectUris(undefined)).not.toContain(MOBILE_REDIRECT_URI);
        expect(parseTrustedExtensionRedirectUris(MOBILE_REDIRECT_URI)).toEqual([MOBILE_REDIRECT_URI]);
        expect(parseTrustedExtensionRedirectUris(`${SHIPPED_FIREFOX_REDIRECT_URI},${NATIVE_REDIRECT_URI},${MOBILE_REDIRECT_URI}`)).toEqual([
            SHIPPED_FIREFOX_REDIRECT_URI,
            NATIVE_REDIRECT_URI,
            MOBILE_REDIRECT_URI,
        ]);
        expect(
            parseTrustedExtensionRedirectUris(
                "neore-mobile://auth/callback/x,neore-mobile://other,NEORE-MOBILE://auth/callback,neore-mobile://auth/callback?x=1",
            ),
        ).toEqual([]);
        expect(console.warn).toHaveBeenCalledTimes(4);
    });

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

    it("reaches the deployed Worker: the var is in the optional passthrough", () => {
        expect(OPTIONAL_ENV_KEYS).toContain("TRUSTED_EXTENSION_REDIRECT_URIS");
    });

    it("accepts browser-intercepted redirect URIs, with or without the trailing slash", () => {
        expect(parseTrustedExtensionRedirectUris(`${FIREFOX_REDIRECT.slice(0, -1)}, ${CHROME_REDIRECT},${FIREFOX_REDIRECT}`)).toEqual([
            FIREFOX_REDIRECT,
            CHROME_REDIRECT,
        ]);
    });

    it("reads a Chrome extension id, bare or as its origin, as the id's redirect URI", () => {
        const id = "b".repeat(32);

        expect(parseTrustedExtensionRedirectUris(`${id}, chrome-extension://${id}/,${NATIVE_REDIRECT_URI}`)).toEqual([
            `https://${id}.chromiumapp.org/`,
            NATIVE_REDIRECT_URI,
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

describe("carryRetiredExtensionOrigins", () => {
    const ID = "c".repeat(32);
    const CHROME = `https://${ID}.chromiumapp.org/`;

    it.each([
        ["an unset list, keeping the Firefox default", undefined, `${SHIPPED_FIREFOX_REDIRECT_URI},${CHROME}`],
        [
            "a list with the app callbacks, keeping them",
            `${NATIVE_REDIRECT_URI},${MOBILE_REDIRECT_URI}`,
            `${NATIVE_REDIRECT_URI},${MOBILE_REDIRECT_URI},${CHROME}`,
        ],
    ])("adds the old Chrome origin's redirect URI to %s", (_label, redirectUris, expected) => {
        const carried = carryRetiredExtensionOrigins(`chrome-extension://${ID}`, redirectUris);

        expect(carried).toEqual({ added: [CHROME], value: expected, withheld: [] });
        expect(parseTrustedExtensionRedirectUris(carried.value)).toEqual(expected.split(","));
    });

    it("moves an old origin written with several trailing slashes, as the retired parser accepted it", () => {
        expect(carryRetiredExtensionOrigins(`chrome-extension://${ID}//`, undefined)).toEqual({
            added: [CHROME],
            value: `${SHIPPED_FIREFOX_REDIRECT_URI},${CHROME}`,
            withheld: [],
        });
    });

    it.each([
        ["no Chrome origin", "chrome-extension://not-an-id,moz-extension://x", undefined],
        ["an already listed URI, copied without its slash", `chrome-extension://${ID}/`, `https://${ID}.chromiumapp.org`],
        ["an id already listed bare", `chrome-extension://${ID}`, ID],
        ["nothing", undefined, undefined],
    ])("moves nothing for %s", (_label, origins, redirectUris) => {
        expect(carryRetiredExtensionOrigins(origins, redirectUris)).toEqual({ added: [], value: redirectUris, withheld: [] });
    });

    it("keeps a switched-off sign-in off, naming the URI it did not move", () => {
        expect(carryRetiredExtensionOrigins(`chrome-extension://${ID}`, "none")).toEqual({ added: [], value: "none", withheld: [CHROME] });
    });
});
