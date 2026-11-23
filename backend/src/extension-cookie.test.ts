import { describe, expect, it } from "vitest";

import { withoutExtensionCookie } from "./extension-cookie";

const request = (headers: Record<string, string>, init: RequestInit = {}) => new Request("https://api.example.test/_lunora/rpc", { ...init, headers });

describe("withoutExtensionCookie", () => {
    it.each(["chrome-extension://abcdefghijklmnopabcdefghijklmnop", "moz-extension://0b4e4c2a-1b1c-4c1d-9e1f-0a1b2c3d4e5f", "safari-web-extension://x"])(
        "drops the cookie a request from %s carries, keeping its bearer",
        (origin) => {
            const stripped = withoutExtensionCookie(request({ authorization: "Bearer t", cookie: "session=s", origin }));

            expect(stripped.headers.get("cookie")).toBeNull();
            expect(stripped.headers.get("authorization")).toBe("Bearer t");
        },
    );

    it("keeps the body of a stripped request", async () => {
        const stripped = withoutExtensionCookie(
            request({ cookie: "session=s", origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }, { body: '{"a":1}', method: "POST" }),
        );

        expect(await stripped.text()).toBe('{"a":1}');
    });

    it("leaves the web app's cookie requests and cookie-less requests untouched", () => {
        const web = request({ cookie: "session=s", origin: "https://app.example.test" });
        const lookalike = request({ cookie: "session=s", origin: "https://chrome-extension.example.test" });
        const sameOrigin = request({ cookie: "session=s" });
        const bearerOnly = request({ authorization: "Bearer t", origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });

        expect(withoutExtensionCookie(web)).toBe(web);
        expect(withoutExtensionCookie(lookalike)).toBe(lookalike);
        expect(withoutExtensionCookie(sameOrigin)).toBe(sameOrigin);
        expect(withoutExtensionCookie(bearerOnly)).toBe(bearerOnly);
    });
});
