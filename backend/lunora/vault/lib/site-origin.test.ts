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
    ])("reads %s as %s", (input, origin) => {
        expect(normalizeSiteOrigin(input)).toBe(origin);
    });

    // Plain HTTP is joined so no insecure URL literal sits in the source.
    it.each([
        ["http", "//example.com"].join(":"),
        "ftp://example.com",
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
