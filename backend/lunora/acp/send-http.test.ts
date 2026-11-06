import { beforeEach, describe, expect, it, vi } from "vitest";

import { hostSendHttpAction } from "./send";

const caller = vi.hoisted(() => {
    return { user: null as null | { _id: string; plan?: string | null } };
});

vi.mock("../auth/lib/helper", () => {
    return { getCurrentUserInternal: async () => caller.user };
});

const post = (body: unknown): Request => new Request("https://example.test/hosts/send", { body: JSON.stringify(body), method: "POST" });

describe("POST /hosts/send for a signed-in owner", () => {
    beforeEach(() => {
        vi.stubEnv("LLM_GATEWAY_SIGNING_SECRET", "secret");
        caller.user = { _id: "owner-1", plan: null };
    });

    it("forwards the prompt without its hidden characters, for the caller, to the send mutation", async () => {
        const runMutation = vi.fn(async () => {
            return { outcome: "busy" as const };
        });

        await hostSendHttpAction({ runMutation } as never, post({ requestId: "req-1", text: "fix\u{E0041} the\u{202E} bug", threadId: "thread-1" }));

        expect(runMutation).toHaveBeenCalledTimes(1);
        const args = (runMutation.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];

        expect(args).toMatchObject({ requestId: "req-1", text: "fix the bug", threadId: "thread-1", userId: "owner-1" });
    });

    it("cleans the hidden characters out of a body within the cap, and sends the prompt that remains", async () => {
        const runMutation = vi.fn(async () => {
            return { outcome: "busy" as const };
        });
        const zeroWidthSpace = "\u{200B}";
        const text = `${"x".repeat(20_000)}${zeroWidthSpace.repeat(5000)}`;

        await hostSendHttpAction({ runMutation } as never, post({ requestId: "req-1", text, threadId: "thread-1" }));

        const args = (runMutation.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];

        expect(args).toMatchObject({ text: "x".repeat(20_000) });
    });

    it("sends nothing for a caller who is not signed in", async () => {
        caller.user = null;
        const runMutation = vi.fn();

        const response = await hostSendHttpAction({ runMutation } as never, post({ requestId: "req-1", text: "fix the bug", threadId: "thread-1" }));

        expect(response.status).toBe(401);
        expect(runMutation).not.toHaveBeenCalled();
    });
});
