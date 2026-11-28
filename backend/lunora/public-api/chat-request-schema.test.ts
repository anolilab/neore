/**
 * `zChatRequestSchema` (`POST /chat`): the optional `reasoningEffort` takes an integer from 0 to 100, the app's slider scale, and
 * refuses anything else before a run is billed.
 */
import { describe, expect, it } from "vitest";

import { zChatRequestSchema } from "./schemas";

const parse = (extra: Record<string, unknown>) => zChatRequestSchema.safeParse({ prompt: "hi", ...extra });

describe("zChatRequestSchema reasoningEffort", () => {
    it("is optional", () => {
        const parsed = parse({});

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.reasoningEffort).toBeUndefined();
    });

    it.each([0, 25, 50, 100, 33])("accepts %s", (reasoningEffort) => {
        const parsed = parse({ reasoningEffort });

        expect(parsed.success && parsed.data.reasoningEffort).toBe(reasoningEffort);
    });

    it.each([-1, 101, 2.5, NaN, Infinity, "50", null, true])("refuses %s", (reasoningEffort) => {
        expect(parse({ reasoningEffort }).success).toBe(false);
    });
});
