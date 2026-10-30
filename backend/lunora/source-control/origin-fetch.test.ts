import { describe, expect, it } from "vitest";

import { createBoundRequester, HostApiError } from "./origin-fetch";

const ORIGIN = "https://api.github.com";

interface Seen {
    authorization: string | null;
    url: string;
}

/** A transport that answers from a script and records every request, for every host. */
const transport = (answer: (url: string) => Response) => {
    const seen: Seen[] = [];
    const via = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);

        seen.push({ authorization: new Headers(init?.headers).get("authorization"), url });

        expect(init?.redirect).toBe("manual");

        return answer(url);
    };

    return { seen, via };
};

const redirect = (location: string, status = 302) => new Response(null, { headers: { location }, status });

describe("createBoundRequester", () => {
    it("sends the token to its origin, with the query", async () => {
        const { seen, via } = transport(() => Response.json({}));

        await createBoundRequester({ origin: ORIGIN, token: "tkn", via })("/repos/o/r/pulls", { query: { page: 2 } });

        expect(seen).toEqual([{ authorization: "Bearer tkn", url: "https://api.github.com/repos/o/r/pulls?page=2" }]);
    });

    it("never sends the token to another host that a redirect names", async () => {
        const { seen, via } = transport((url) => (url.startsWith(ORIGIN) ? redirect("https://evil.example/steal") : Response.json({})));

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via })("/repos/o/r")).rejects.toMatchObject({ name: "HostApiError", status: 0 });

        expect(seen.map((entry) => entry.url)).toEqual(["https://api.github.com/repos/o/r"]);
    });

    it.each([
        ["a scheme-relative address", "//evil.example/x"],
        ["another port", "https://api.github.com:8443/x"],
        ["plain http", ["http", "://api.github.com/x"].join("")],
        ["a look-alike host", "https://api.github.com.evil.example/x"],
        ["a userinfo trick", "https://api.github.com@evil.example/x"],
    ])("refuses a redirect to %s", async (_name, location) => {
        const { seen, via } = transport((url) => (url.startsWith(ORIGIN) && url.length < 40 ? redirect(location) : Response.json({})));

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via })("/repos/o/r")).rejects.toBeInstanceOf(HostApiError);
        expect(seen).toHaveLength(1);
    });

    it("follows a redirect that stays on the origin, and gives up after the limit", async () => {
        const moved = transport((url) => (url.endsWith("/old") ? redirect("/repos/o/new", 301) : Response.json({ ok: true })));
        const response = await createBoundRequester({ origin: ORIGIN, token: "tkn", via: moved.via })("/repos/o/old");

        expect(await response.json()).toEqual({ ok: true });
        expect(moved.seen.map((entry) => entry.authorization)).toEqual(["Bearer tkn", "Bearer tkn"]);

        const loop = transport(() => redirect("/again"));

        await expect(createBoundRequester({ maxRedirects: 2, origin: ORIGIN, token: "tkn", via: loop.via })("/start")).rejects.toBeInstanceOf(HostApiError);
        expect(loop.seen).toHaveLength(3);
    });

    it.each(["repos/o/r", "//evil.example/x", "https://evil.example/x", ""])("refuses the path %j", async (path) => {
        const { seen, via } = transport(() => Response.json({}));

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via })(path)).rejects.toBeInstanceOf(HostApiError);
        expect(seen).toEqual([]);
    });

    it.each([
        [404, {}, { rateLimited: false, status: 404 }],
        [403, { "x-ratelimit-remaining": "0" }, { rateLimited: true, status: 403 }],
        [403, {}, { rateLimited: false, status: 403 }],
        [429, {}, { rateLimited: true, status: 429 }],
    ])("cancels the body of a %i response, and flags a rate limit", async (status, headers, expected) => {
        let cancelled = false;
        const response = new Response(
            new ReadableStream({
                cancel() {
                    cancelled = true;
                },
            }),
            { headers, status },
        );

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via: async () => response })("/x")).rejects.toMatchObject(expected);
        expect(cancelled).toBe(true);
    });

    it("turns a transport failure into a refused request, not a throw of its own", async () => {
        const via = async (): Promise<Response> => {
            throw new TypeError("fetch failed");
        };

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via })("/x")).rejects.toMatchObject({ name: "HostApiError", status: 0 });
    });
});
