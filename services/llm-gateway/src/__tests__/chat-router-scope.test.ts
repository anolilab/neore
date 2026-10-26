import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { HonoEnv } from "../env.js";
import { chatRouter } from "../routes/v1/chat.js";
import { clientStreamRouter } from "../routes/v1/client-stream.js";

/**
 * The app mounts the chat router at "/" before the stream router. Its model check
 * must not run for `/v1/stream`, which sends a stream token and no model.
 */
describe("chat router scope", () => {
    const app = new Hono<HonoEnv>();

    app.route("/", chatRouter);
    app.route("/", clientStreamRouter);

    it("does not apply the chat model check to the stream route", async () => {
        const res = await app.fetch(
            new Request("http://localhost/v1/stream", {
                body: JSON.stringify({ streamToken: "not-a-real-token" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
            { SIGNING_SECRET: "test-signing-secret" },
        );

        // The stream handler rejects the fake token itself: the request reached it.
        expect(res.status).toBe(401);
        expect(await res.json()).not.toEqual({ error: "Invalid model ID" });
    });

    it("still applies the chat model check to /v1/chat", async () => {
        const res = await app.fetch(
            new Request("http://localhost/v1/chat", {
                body: JSON.stringify({ prompt: "hi" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid model ID" });
    });
});
