import { describe, expect, it } from "vitest";

import { urlHost } from "./url-host";

describe(urlHost, () => {
    it.each([
        ["https://Shop.Example.com/a?b=1", "shop.example.com"],
        ["https://shop.example./x", "shop.example"],
        ["https://shop.example../x", "shop.example"],
        ["https://bücher.example./", "xn--bcher-kva.example"],
        ["https://shop.example:8443/", "shop.example"],
    ])("reads %s as %s", (url, host) => {
        expect(urlHost(url)).toBe(host);
    });

    it("names no host for an unreadable URL or none", () => {
        expect(urlHost("not a url")).toBe("");
        expect(urlHost(undefined)).toBe("");
    });
});
