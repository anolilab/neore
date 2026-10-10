/**
 * content-safety.integration.test.ts
 *
 * Pins WHERE chat content safety is enforced, through the real app wiring in
 * `src/index.ts` rather than the middleware in isolation. `/v1/chat*` only
 * forwards to the backend; every model call the backend makes comes back
 * through `/internal/model/proxy`, and that registration is the one check. If
 * someone drops `contentSafetyMiddleware` from it, the first test fails.
 *
 * Neither request reaches a provider: the banned one is refused by the filter,
 * the benign one stops at the route's own schema validation — which it can only
 * reach after passing HMAC twice and the filter once.
 */
import { describe, expect, it } from "vitest";

import { app } from "../../index.js";
import { bindingEnv, makeInternalRequest } from "../helpers/internal.js";
import { createMockCtx as createMockContext, createMockEnv } from "../helpers/mock-env.js";

const proxy = async (text: string) => {
    const body = JSON.stringify({
        callOptions: { prompt: [{ content: [{ text, type: "text" }], role: "user" }] },
    });
    const request = makeInternalRequest("POST", "/internal/model/proxy", body);
    const context = createMockContext();
    const response = await app.fetch(request, bindingEnv(createMockEnv()), context as unknown as ExecutionContext);

    // Settle anything the request handed to `waitUntil` (logging, usage) before
    // the test ends: a log emitted after teardown fails the whole run with
    // "EnvironmentTeardownError: Closing rpc while onUserConsoleLog was pending".
    await context.flush();

    return response;
};

describe("content safety — the /internal/model/proxy enforcement point", () => {
    it("refuses a real banned word in the user prompt", async () => {
        // "damn": the mildest term the dictionary flags, as in content-safety.test.ts.
        const res = await proxy("well damn, reply with pong");

        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("BANNED_CONTENT");
    });

    it('lets a benign prompt that says "chat" through the filter and both HMAC checks', async () => {
        const res = await proxy("Generate a title for this chat. Reply with exactly the word: pong");
        const text = await res.text();

        // Reaching the route's zod validation (400, not BANNED_CONTENT, not the
        // locked-stream 500) proves the request passed everything before it.
        expect(res.status).toBe(400);
        expect(text).not.toContain("BANNED_CONTENT");
        expect(text).toContain("ZodError");
    });
});
