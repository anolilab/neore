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

    it("keeps the host error contract when a redirect body fails to cancel", async () => {
        const body = new ReadableStream({
            cancel: () => Promise.reject(new Error("stream broke")),
        });
        const via = async () => new Response(body, { headers: { location: "https://evil.example/x" }, status: 302 });

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via })("/repos/o/r")).rejects.toMatchObject({ name: "HostApiError", status: 0 });
    });

    it("marks a write the host answered with a redirect unconfirmed, and a read not", async () => {
        const write = transport(() => redirect("/repos/o/new", 307));

        await expect(
            createBoundRequester({ origin: ORIGIN, token: "tkn", via: write.via })("/repos/o/r/pulls/1/merge", { json: {}, method: "PUT" }),
        ).rejects.toMatchObject({
            name: "HostApiError",
            unconfirmed: true,
        });
        expect(write.seen).toHaveLength(1);

        const loop = transport(() => redirect("/again"));

        await expect(createBoundRequester({ maxRedirects: 0, origin: ORIGIN, token: "tkn", via: loop.via })("/start")).rejects.toMatchObject({
            unconfirmed: false,
        });
    });

    it("never sends the token to a plain-http origin", async () => {
        const { seen, via } = transport(() => Response.json({}));

        // eslint-disable-next-line unicorn/prefer-https -- a plain-http origin is the case under test
        await expect(createBoundRequester({ origin: "http://git.example", token: "tkn", via })("/repos/o/r")).rejects.toMatchObject({
            name: "HostApiError",
            status: 0,
        });

        expect(seen).toEqual([]);
    });

    it("never sends the token to another host that a redirect names", async () => {
        const { seen, via } = transport((url) => (new URL(url).origin === ORIGIN ? redirect("https://evil.example/steal") : Response.json({})));

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
        const { seen, via } = transport((url) => (new URL(url).origin === ORIGIN && url.length < 40 ? redirect(location) : Response.json({})));

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
    ])("releases the body of a %i response, and flags a rate limit", async (status, headers, expected) => {
        let released = false;
        // A body that was read to its end closes the stream (`pull` finds nothing more); one that was not is cancelled.
        const response = new Response(
            new ReadableStream({
                cancel() {
                    released = true;
                },
                pull(controller) {
                    controller.close();
                    released = true;
                },
            }),
            { headers, status },
        );

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via: async () => response })("/x")).rejects.toMatchObject(expected);
        expect(released).toBe(true);
    });

    it.each([
        ["GET", "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."],
        ["GET", "API rate limit exceeded for user ID 1."],
        ["POST", "You have exceeded a SECONDARY RATE LIMIT."],
    ] as const)("flags a bare 403 whose message names a rate limit (%s)", async (method, message) => {
        const via = async () => Response.json({ message }, { status: 403 });

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via })("/x", { method })).rejects.toMatchObject({ rateLimited: true, status: 403 });
    });

    it("keeps a 403 that is a plain refusal a refusal, and a huge hostile message linear", async () => {
        const refusal = async () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 });

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via: refusal })("/x")).rejects.toMatchObject({ rateLimited: false, status: 403 });

        const hostile = async () => Response.json({ message: "rate limi".repeat(100_000) }, { status: 403 });
        const started = performance.now();

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via: hostile })("/x")).rejects.toMatchObject({ rateLimited: false });
        expect(performance.now() - started).toBeLessThan(3000);
    });

    it("does not read a rate limit out of the message of a status that is not 403", async () => {
        const via = async () => Response.json({ message: "rate limit" }, { status: 422 });

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via })("/x", { method: "POST" })).rejects.toMatchObject({ rateLimited: false });
    });

    it("turns a transport failure into a refused request, not a throw of its own", async () => {
        const via = async (): Promise<Response> => {
            throw new TypeError("fetch failed");
        };

        await expect(createBoundRequester({ origin: ORIGIN, token: "tkn", via })("/x")).rejects.toMatchObject({ name: "HostApiError", status: 0 });
    });

    describe("writes", () => {
        it("sends a JSON body with the method, to the bound origin only", async () => {
            const bodies: { body: unknown; contentType: string | null; method: string | undefined }[] = [];
            const via = async (_input: Request | string | URL, init?: RequestInit): Promise<Response> => {
                bodies.push({ body: init?.body, contentType: new Headers(init?.headers).get("content-type"), method: init?.method });

                return Response.json({ id: 1 });
            };

            await createBoundRequester({ origin: ORIGIN, token: "tkn", via })("/repos/o/r/pulls/1/reviews", { json: { event: "COMMENT" }, method: "POST" });

            expect(bodies).toEqual([{ body: '{"event":"COMMENT"}', contentType: "application/json", method: "POST" }]);
        });

        it("never replays a write after a redirect, even one that stays on the origin", async () => {
            const { seen, via } = transport(() => redirect("/repos/o/new", 307));

            await expect(
                createBoundRequester({ origin: ORIGIN, token: "tkn", via })("/repos/o/old/pulls/1/reviews", { json: { body: "x" }, method: "POST" }),
            ).rejects.toMatchObject({ name: "HostApiError", status: 0 });
            expect(seen).toHaveLength(1);
        });

        it("keeps the host's reason for a refused write, and not for a refused read", async () => {
            const refuse = () => Response.json({ message: "Unprocessable Entity: Can not approve your own pull request" }, { status: 422 });
            const requester = createBoundRequester({ origin: ORIGIN, token: "tkn", via: async () => refuse() });

            await expect(requester("/x", { json: {}, method: "POST" })).rejects.toMatchObject({
                detail: "Unprocessable Entity: Can not approve your own pull request",
                status: 422,
                unconfirmed: false,
            });
            await expect(requester("/x")).rejects.toMatchObject({ detail: undefined, status: 422 });
        });

        it("marks a write whose answer never came as unconfirmed, and a read as not", async () => {
            const via = async (): Promise<Response> => {
                throw new DOMException("timed out", "TimeoutError");
            };
            const requester = createBoundRequester({ origin: ORIGIN, token: "tkn", via });

            await expect(requester("/x", { json: {}, method: "POST" })).rejects.toMatchObject({ status: 0, unconfirmed: true });
            await expect(requester("/x")).rejects.toMatchObject({ status: 0, unconfirmed: false });
        });
    });
});
