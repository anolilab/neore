import { describe, expect, it } from "vitest";

import { isLocalEndpointHost, toLocalServerRoot, validateLocalEndpointUrl } from "./local-endpoint";

/** Plain-http URLs, built at runtime: they are the subject under test, not a lint slip. */
const plain = (rest: string) => ["http", rest].join("://");

describe(validateLocalEndpointUrl, () => {
    it.each([
        ["http://localhost:11434/v1", "http://localhost:11434/v1"],
        ["http://127.0.0.1:1234/v1/", "http://127.0.0.1:1234/v1"],
        ["  https://LOCALHOST:8443/v1?x=1#y ", "https://localhost:8443/v1"],
        ["http://localhost/v1", "http://localhost/v1"],
    ])("accepts the loopback URL %s", (raw, url) => {
        expect.assertions(1);
        expect(validateLocalEndpointUrl(raw)).toStrictEqual({ url });
    });

    it.each([
        ["LAN address", plain("192.168.1.20:11434/v1")],
        ["mDNS name", plain("my-mac.local:11434/v1")],
        ["localhost subdomain", plain("evil.localhost:11434/v1")],
        ["IPv6 loopback (no CSP source can express it)", plain("[::1]:11434/v1")],
        ["public host", "https://ollama.example.com/v1"],
        ["other loopback address", plain("127.0.0.2:11434/v1")],
    ])("refuses a %s", (_label, raw) => {
        expect.assertions(1);
        expect(validateLocalEndpointUrl(raw)).toHaveProperty("error");
    });

    it("refuses non-http schemes and credentials", () => {
        expect.assertions(3);
        expect(validateLocalEndpointUrl("ftp://localhost/v1")).toHaveProperty("error");
        expect(validateLocalEndpointUrl("http://user:pw@localhost:11434/v1")).toHaveProperty("error");
        expect(validateLocalEndpointUrl("not a url")).toHaveProperty("error");
    });
});

describe(isLocalEndpointHost, () => {
    it("is case-insensitive and exact", () => {
        expect.assertions(3);
        expect(isLocalEndpointHost("LocalHost")).toBe(true);
        expect(isLocalEndpointHost("127.0.0.1")).toBe(true);
        expect(isLocalEndpointHost("localhost.example.com")).toBe(false);
    });
});

describe(toLocalServerRoot, () => {
    it("strips a trailing /v1 and slashes", () => {
        expect.assertions(3);
        expect(toLocalServerRoot("http://localhost:11434/v1")).toBe("http://localhost:11434");
        expect(toLocalServerRoot("http://localhost:11434/v1/")).toBe("http://localhost:11434");
        expect(toLocalServerRoot("http://localhost:11434")).toBe("http://localhost:11434");
    });
});
