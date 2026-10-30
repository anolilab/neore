import { describe, expect, it } from "vitest";

import { backendOrigin, clampText, isSameOrigin, originOf, parseDeepLink, remotePattern, siteOrigin, threadUrl } from "./site";
import { isTrustedUrl } from "./trust";

const origin = new URL("https://app.example.com");

const parse = (link: string) => parseDeepLink(origin, new URL(link));

describe("origin", () => {
    it("drops path, query and fragment", () => {
        expect(originOf(new URL("https://app.example.com:8443/chat?x=1#y"))?.href).toBe("https://app.example.com:8443/");
        expect(originOf(new URL("file:///etc/passwd"))).toBeUndefined();
    });

    it("covers the whole origin in the remote pattern", () => {
        expect(remotePattern(origin)).toBe("https://app.example.com/*");
        expect(remotePattern(new URL("http://localhost:5173"))).toBe("http://localhost:5173/*");
    });

    it("refuses a build without an http(s) origin", () => {
        expect(() => siteOrigin("file:///etc/passwd")).toThrow();
        expect(siteOrigin("https://app.example.com/some/path").href).toBe("https://app.example.com/");
    });

    it("takes the backend origin from the build, and refuses a non-http(s) one", () => {
        expect(backendOrigin("https://api.example.com/some/path").href).toBe("https://api.example.com/");
        expect(() => backendOrigin("file:///etc/passwd")).toThrow();
    });

    it("sends agent data over plain http to this machine only", () => {
        expect(backendOrigin("http://localhost:8788").href).toBe("http://localhost:8788/");
        expect(backendOrigin("http://127.0.0.1:8788").href).toBe("http://127.0.0.1:8788/");
        expect(backendOrigin("http://[::1]:8788").href).toBe("http://[::1]:8788/");
        // eslint-disable-next-line unicorn/prefer-https -- the scheme is the thing this case checks
        expect(() => backendOrigin("http://api.example.com")).toThrow("https");
        // eslint-disable-next-line unicorn/prefer-https -- the scheme is the thing this case checks
        expect(() => backendOrigin("http://localhost.evil.test")).toThrow("https");
    });

    it("compares scheme, host and port", () => {
        expect(isSameOrigin(origin, new URL("https://app.example.com/chat/x"))).toBe(true);
        // eslint-disable-next-line unicorn/prefer-https -- the scheme is the thing this case checks
        expect(isSameOrigin(origin, new URL("http://app.example.com/"))).toBe(false);
        expect(isSameOrigin(origin, new URL("https://app.example.com.evil.test/"))).toBe(false);
    });
});

describe("deep links", () => {
    it("opens a thread", () => {
        expect(parse("neore://thread/abc_123-X")).toEqual({ kind: "open", url: new URL("https://app.example.com/chat/abc_123-X") });
        expect(parse("neore://thread/abc/")).toEqual({ kind: "open", url: new URL("https://app.example.com/chat/abc") });
    });

    it("refuses thread ids that are not ids", () => {
        expect(parse("neore://thread/..%2F..%2Fadmin")).toBeUndefined();
        expect(parse("neore://thread/a/b")).toBeUndefined();
        expect(parse("neore://thread/default")).toBeUndefined();
        expect(parse("neore://thread/")).toBeUndefined();
        expect(parse(`neore://thread/${"a".repeat(129)}`)).toBeUndefined();
        expect(threadUrl(origin, "a".repeat(128))).toBeDefined();
    });

    it("composes from text", () => {
        expect(parse("neore://new?text=hello%20world")).toEqual({ kind: "compose", text: "hello world" });
        expect(parse("neore://new?text=%20%20")).toEqual({ kind: "focus" });
        expect(parse("neore://new")).toEqual({ kind: "focus" });
        expect(parse("neore://")).toEqual({ kind: "focus" });
    });

    it("ignores other schemes and hosts", () => {
        expect(parse("https://app.example.com/chat/abc")).toBeUndefined();
        expect(parse("neore://settings/billing")).toBeUndefined();
    });

    it("clamps by characters, not bytes", () => {
        expect(clampText("  äöü  ", 2)).toBe("äö");
    });
});

describe("trusted senders", () => {
    it("trusts only the site origin", () => {
        expect(isTrustedUrl(origin, "https://app.example.com/chat/x")).toBe(true);
        // eslint-disable-next-line unicorn/prefer-https -- the scheme is the thing this case checks
        expect(isTrustedUrl(origin, "http://app.example.com/chat/x")).toBe(false);
        expect(isTrustedUrl(origin, "https://accounts.google.com/o/oauth2/auth")).toBe(false);
        expect(isTrustedUrl(origin, "https://app.example.com.evil.test/")).toBe(false);
        expect(isTrustedUrl(origin, undefined)).toBe(false);
        expect(isTrustedUrl(origin, "not a url")).toBe(false);
    });
});
