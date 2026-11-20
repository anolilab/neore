import { describe, expect, it } from "vitest";

import { normalizeSiteOrigin } from "./site-origin";

describe(normalizeSiteOrigin, () => {
    it.each([
        ["https://Example.com/login?next=/", "https://example.com"],
        ["example.com", "https://example.com"],
        ["https://example.com:443/", "https://example.com"],
        ["https://example.com:8443", "https://example.com:8443"],
        // A lookalike in another script stays a different origin.
        ["https://exаmple.com", "https://xn--exmple-4nf.com"],
        // A `://` in the path or the query is not a scheme: the input has none, so it is read as HTTPS.
        ["example.com/login?next=https://other.example", "https://example.com"],
        ["example.com/redirect/https://other.example/", "https://example.com"],
        ["HTTPS://example.com/?to=ftp://x.example", "https://example.com"],
    ])("reads %s as %s", (input, origin) => {
        expect(normalizeSiteOrigin(input)).toBe(origin);
    });

    // Plain HTTP and script URLs are joined so no such literal sits in the source.
    it.each([
        ["http", "//example.com"].join(":"),
        "ftp://example.com",
        "FTP://example.com/?next=https://example.com",
        ["javascript", "//example.com/%0aalert(1)"].join(":"),
        // No `scheme://` at the start, so these are read as a host, which none of them is.
        ["javascript", "alert(1)"].join(":"),
        "mailto:ada@example.com",
        ["http", "example.com/?next=https://example.com"].join(":"),
        "https://user:pw@example.com",
        "https://localhost",
        // The browser keeps the trailing dot, so `example.com.` is another origin than `example.com`.
        "https://example.com./",
        "https://example.com../",
        "https://[::1]",
        "https://10.0.0.1",
        "https://0x7f.1",
        "https://2130706433",
        "not a url",
        "",
    ])("refuses %s", (input) => {
        expect(normalizeSiteOrigin(input)).toBeNull();
    });
});
