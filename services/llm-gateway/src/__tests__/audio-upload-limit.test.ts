/**
 * Tests for the upload cap on POST /v1/audio/transcriptions.
 *
 * `c.req.formData()` buffers the whole body, so an oversized upload has to be
 * refused on its declared Content-Length before the body is parsed.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { HonoEnv } from "../env.js";
import { audioRouter } from "../routes/v1/audio.js";
import { createMockCtx, createMockEnv, makeVirtualKeyRow } from "./helpers/mock-env.js";

const TEST_TOKEN = "gk_test_audio_token_abc123";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// The router is not mounted by the gateway entry point, so exercise it directly.
const app = new Hono<HonoEnv>().route("/", audioRouter);

const transcribe = async (contentLength?: number) => {
    const row = await makeVirtualKeyRow(TEST_TOKEN, { tier: "pro", user_id: "user-audio-001" });
    const env = createMockEnv({ apiKeyCacheRows: [row] });
    const form = new FormData();

    form.set("model", "whisper-large-v3");

    const headers: Record<string, string> = { Authorization: `Bearer ${TEST_TOKEN}` };

    if (contentLength !== undefined) headers["Content-Length"] = String(contentLength);

    return app.fetch(new Request("http://localhost/v1/audio/transcriptions", { body: form, headers, method: "POST" }), env, createMockCtx());
};

describe("POST /v1/audio/transcriptions upload cap", () => {
    it("answers 413 for a declared Content-Length over the cap, before parsing the body", async () => {
        const res = await transcribe(MAX_AUDIO_BYTES + 2 * 1024 * 1024);

        expect(res.status).toBe(413);
    });

    it("does not refuse a declared length within the cap plus multipart overhead", async () => {
        // No file part, so the handler gets past the size gate and fails on the missing field instead.
        const res = await transcribe(MAX_AUDIO_BYTES + 1024);

        expect(res.status).toBe(400);
    });
});
