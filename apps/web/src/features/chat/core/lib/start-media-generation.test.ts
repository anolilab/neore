// @vitest-environment node

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startMediaGeneration } from "./start-media-generation";

const MEDIA_URL = "https://gateway.test/v1/chat/media";
const server = setupServer();

const start = () => startMediaGeneration({ body: { messageId: "m1", threadId: "t1" }, headers: { Authorization: "Bearer token" }, url: MEDIA_URL });

describe("startMediaGeneration", () => {
    beforeAll(() => {
        server.listen({ onUnhandledFrame: "error" });
    });
    afterEach(() => {
        server.resetHandlers();
    });
    afterAll(() => {
        server.close();
    });

    it("posts the JSON body with the auth header and reports success on a 2xx", async () => {
        let seen: { auth: string | null; body: unknown; contentType: string | null } | undefined;

        server.use(
            http.post(MEDIA_URL, async ({ request }) => {
                seen = { auth: request.headers.get("Authorization"), body: await request.json(), contentType: request.headers.get("Content-Type") };

                return HttpResponse.json({ ok: true });
            }),
        );

        await expect(start()).resolves.toStrictEqual({ ok: true });
        expect(seen).toStrictEqual({ auth: "Bearer token", body: { messageId: "m1", threadId: "t1" }, contentType: "application/json" });
    });

    it("returns the daily limit refusal with the server's wording", async () => {
        server.use(
            http.post(MEDIA_URL, () =>
                HttpResponse.json(
                    { error: "DAILY_MESSAGE_LIMIT_REACHED", message: "You've reached your daily message limit.", retryAfter: 3600 },
                    { status: 403 },
                ),
            ),
        );

        await expect(start()).resolves.toStrictEqual({
            code: "DAILY_MESSAGE_LIMIT_REACHED",
            kind: "refused",
            message: "You've reached your daily message limit.",
            ok: false,
            retryAfter: 3600,
            status: 403,
        });
    });

    it("reads the nested rate-limit shape", async () => {
        server.use(http.post(MEDIA_URL, () => HttpResponse.json({ error: { code: "RATE_LIMITED", message: "Slow down", retryAfter: 12 } }, { status: 429 })));

        await expect(start()).resolves.toStrictEqual({ code: "RATE_LIMITED", kind: "refused", message: "Slow down", ok: false, retryAfter: 12, status: 429 });
    });

    it("returns a 500 with a non-JSON body as a refusal with only a status", async () => {
        server.use(http.post(MEDIA_URL, () => new HttpResponse("upstream exploded", { status: 500 })));

        await expect(start()).resolves.toStrictEqual({ code: undefined, kind: "refused", message: undefined, ok: false, retryAfter: undefined, status: 500 });
    });

    it("turns a network error into a result instead of rejecting", async () => {
        server.use(http.post(MEDIA_URL, () => HttpResponse.error()));

        const result = await start();

        expect(result).toMatchObject({ kind: "network", ok: false });
    });
});
