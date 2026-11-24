/**
 * Generation draws one unit per image from the same daily image allowance as editing, by the user's server-side plan.
 * A spent allowance is refused with a coded error before the provider call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return {
        log: [] as string[],
        plan: { isAdmin: false, plan: null } as { isAdmin: boolean; plan: "premium" | null },
        quotaOk: true,
    };
});

vi.mock("@neore/ai/models", () => {
    return { MEDIA_DEFAULT_MODELS: { image: "fal-ai/recraft/v3/text-to-image" } };
});
vi.mock("../../agent/client", () => {
    return { createTool: (definition: unknown) => definition };
});
vi.mock("../../_generated/internal", () => {
    return {
        internal: {
            auth: { functions: { getUserAuthFlagsQuery: "getUserAuthFlagsQuery" } },
            chat: { functions: { generateImage: "generateImage" } },
            lib: { rate_limiter_mutations: { applyRateLimit: "applyRateLimit" } },
        },
    };
});
vi.mock("../lib/agent-run", () => {
    return { readRunPlan: async () => state.plan };
});

interface GenerationTool {
    execute: (context: unknown, input: { numImages?: number; prompt: string }) => Promise<{ code?: string; error?: string; images: unknown[] }>;
}

const { default: imageGenerationTool } = await import("./image-generation");
const tool = imageGenerationTool as unknown as GenerationTool;

const makeContext = () => {
    return {
        organizationId: null,
        runAction: async (reference: string) => {
            state.log.push(`action:${reference}`);

            return { assets: [{ imageSize: "1:1", imageUrl: "https://fal.example/a.png", mimeType: "image/png" }], modelId: "m", prompt: "p" };
        },
        runMutation: async (_reference: string, args: { count: number; key: string }) => {
            state.log.push(`charge:${args.key}:${args.count}`);

            return state.quotaOk ? { ok: true } : { ok: false, retryAfter: 60 };
        },
        runQuery: async (reference: string) => (reference === "getUserAuthFlagsQuery" ? { isAnonymous: false, plan: null, role: null } : undefined),
        userId: "user-1",
    };
};

beforeEach(() => {
    state.log.length = 0;
    state.plan = { isAdmin: false, plan: null };
    state.quotaOk = true;
});

describe("image generation draws on the daily image allowance", () => {
    it("charges each requested image before generating, to the bucket of the plan the server reads", async () => {
        state.plan = { isAdmin: false, plan: "premium" };

        const output = await tool.execute(makeContext(), { numImages: 2, prompt: "a cat" });

        expect(state.log).toStrictEqual(["charge:chat/dailyImage:premium:2", "action:generateImage"]);
        expect(output.images).toHaveLength(1);
    });

    it("refuses a spent allowance with a coded error, before the provider call", async () => {
        state.quotaOk = false;

        const output = await tool.execute(makeContext(), { prompt: "a cat" });

        expect(output.code).toBe("DAILY_IMAGE_LIMIT_REACHED");
        expect(output.images).toStrictEqual([]);
        expect(state.log).toStrictEqual(["charge:chat/dailyImage:free:1"]);
    });
});
