/**
 * The verdict cache in middleware/content-safety.ts. A run re-sends the same
 * user text on every model step, so the scan must run once per distinct text,
 * and a cached verdict must never change the answer. The checker is wrapped so
 * the tests can count `check()` calls.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { contentSafetyMiddleware } from "../middleware/content-safety.js";

const checkSpy = vi.hoisted(() => vi.fn());

vi.mock("@visulima/content-safety", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@visulima/content-safety")>();

    return {
        ...actual,
        createChecker: (options: Parameters<typeof actual.createChecker>[0]) => {
            const real = actual.createChecker(options);

            return {
                ...real,
                check: (text: string) => {
                    checkSpy(text);

                    return real.check(text);
                },
            };
        },
    };
});

const BANNED = "damn";

const makeApp = () => {
    const app = new Hono();

    app.use("*", contentSafetyMiddleware);
    app.all("*", (c) => c.json({ reached: true }));

    return app;
};

const post = async (text: string) =>
    makeApp().request("/internal/stream", {
        body: JSON.stringify({ messages: [{ content: text, role: "user" }] }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

/** A text no earlier test has sent, so the module-level cache starts cold for it. */
const unique = (label: string) => `${label} ${crypto.randomUUID()}`;

describe("contentSafetyMiddleware — verdict cache", () => {
    it("scans a repeated text once, however many requests carry it", async () => {
        const text = unique("hello there");

        checkSpy.mockClear();

        for (let request = 0; request < 3; request += 1) {
            const response = await post(text);

            expect(response.status).toBe(200);
        }

        expect(checkSpy).toHaveBeenCalledTimes(1);
    });

    it("scans each distinct text on its own", async () => {
        checkSpy.mockClear();

        await post(unique("first"));
        await post(unique("second"));

        expect(checkSpy).toHaveBeenCalledTimes(2);
    });

    it("keeps blocking a banned text on the cached request", async () => {
        const text = `${BANNED} ${crypto.randomUUID()}`;

        checkSpy.mockClear();

        const first = await post(text);
        const second = await post(text);

        expect(first.status).toBe(400);
        expect(second.status).toBe(400);
        expect(await second.json()).toMatchObject({ error: "BANNED_CONTENT" });
        expect(checkSpy).toHaveBeenCalledTimes(1);
    });

    it("bounds the cache: an evicted text is scanned again", async () => {
        const early = unique("evicted early");

        checkSpy.mockClear();

        await post(early);

        // More distinct texts than the cache holds push `early` out.
        for (let index = 0; index < 300; index += 1) {
            await post(unique(`filler ${String(index)}`));
        }

        const callsBeforeReplay = checkSpy.mock.calls.length;

        await post(early);

        expect(checkSpy.mock.calls).toHaveLength(callsBeforeReplay + 1);
    });
});
