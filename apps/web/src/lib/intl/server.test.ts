import { describe, expect, it } from "vitest";

import getLocaleFromRequest from "./server";

const request = (headers: Record<string, string> = {}) => new Request("https://neore.example/auth/sign-in", { headers });

describe("getLocaleFromRequest", () => {
    it("persists the Accept-Language locale, so the client hydrates in the locale the server rendered", () => {
        const result = getLocaleFromRequest(request({ "accept-language": "de-DE,de;q=0.9" }));

        expect(result.locale).toBe("de");
        expect(result.headers).toStrictEqual([expect.objectContaining({ key: "Set-Cookie", value: expect.stringMatching(/^locale=de;/) })]);
    });

    it("sets no cookie when the locale comes from the cookie already", () => {
        const result = getLocaleFromRequest(request({ cookie: "locale=de", "accept-language": "en-US" }));

        expect(result.locale).toBe("de");
        expect(result.headers).toBeUndefined();
    });
});
