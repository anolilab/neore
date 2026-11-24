/**
 * Each image edit draws one unit from the daily image allowance before the provider call, the same bucket generation and
 * `/chat/media` use. A spent allowance refuses the edit with a coded error and never reaches the provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
    return {
        anonymous: false,
        log: [] as string[],
        plan: null as "premium" | null,
        quotaOk: true,
        quotaThrows: false,
        retryAfter: 120,
        role: null as string | null,
    };
});

vi.mock("../../agent/client", () => {
    return { createTool: (definition: unknown) => definition };
});
vi.mock("../../_generated/internal", () => {
    return {
        internal: {
            auth: { functions: { getUserAuthFlagsQuery: "getUserAuthFlagsQuery" } },
            chat: { functions: { editImage: "editImage" } },
            lib: { rate_limiter_mutations: { applyRateLimit: "applyRateLimit" } },
        },
    };
});

interface EditTool {
    execute: (
        context: unknown,
        input: { imageUrl: string; mask?: string; operation: string; prompt?: string },
    ) => Promise<{ code?: string; error?: string; operation: string; resultUrl: string }>;
}

const { default: imageEditingTool } = await import("./image-editing");
const tool = imageEditingTool as unknown as EditTool;

const makeContext = () => {
    return {
        organizationId: null,
        runAction: async (reference: string) => {
            state.log.push(`action:${reference}`);

            return { resultUrl: "https://fal.example/out.png" };
        },
        runMutation: async (_reference: string, args: { count: number; key: string }) => {
            state.log.push(`charge:${args.key}:${args.count}`);

            if (state.quotaThrows) {
                throw new Error("limiter unreachable");
            }

            return state.quotaOk ? { ok: true } : { ok: false, retryAfter: state.retryAfter };
        },
        runQuery: async (reference: string) =>
            reference === "getUserAuthFlagsQuery" ? { isAnonymous: state.anonymous, plan: state.plan, role: state.role } : undefined,
        userId: "user-1",
    };
};

const edit = { imageUrl: "https://example.com/photo.png", operation: "remove_background" };

beforeEach(() => {
    state.anonymous = false;
    state.log.length = 0;
    state.plan = null;
    state.quotaOk = true;
    state.quotaThrows = false;
    state.role = null;
});

describe("image editing draws on the daily image allowance", () => {
    it("charges one image to the free bucket, then runs the edit", async () => {
        const output = await tool.execute(makeContext(), edit);

        expect(state.log).toStrictEqual(["charge:chat/dailyImage:free:1", "action:editImage"]);
        expect(output).toStrictEqual({ operation: "remove_background", resultUrl: "https://fal.example/out.png" });
    });

    it("charges a paid-plan user to the premium bucket", async () => {
        state.plan = "premium";

        await tool.execute(makeContext(), edit);

        expect(state.log).toStrictEqual(["charge:chat/dailyImage:premium:1", "action:editImage"]);
    });

    it("charges a guest to the anonymous bucket", async () => {
        state.anonymous = true;

        await tool.execute(makeContext(), edit);

        expect(state.log).toStrictEqual(["charge:chat/dailyImage:anonymous:1", "action:editImage"]);
    });

    it("does not charge a platform admin, as the media route does not", async () => {
        state.role = "admin";

        await tool.execute(makeContext(), edit);

        expect(state.log).toStrictEqual(["action:editImage"]);
    });

    it("refuses a spent allowance with a coded error, before the provider call", async () => {
        state.quotaOk = false;

        const output = await tool.execute(makeContext(), edit);

        expect(output.code).toBe("DAILY_IMAGE_LIMIT_REACHED");
        expect(output.error?.startsWith("DAILY_IMAGE_LIMIT_REACHED:")).toBe(true);
        expect(output.resultUrl).toBe("");
        expect(state.log).toStrictEqual(["charge:chat/dailyImage:free:1"]);
    });

    it("fails closed with its own code when the allowance cannot be checked", async () => {
        state.quotaThrows = true;

        const output = await tool.execute(makeContext(), edit);

        expect(output.code).toBe("IMAGE_QUOTA_UNAVAILABLE");
        expect(state.log).toStrictEqual(["charge:chat/dailyImage:free:1"]);
    });

    it("spends nothing on a request it refuses itself", async () => {
        const output = await tool.execute(makeContext(), { ...edit, imageUrl: "http://127.0.0.1/secret.png" });

        expect(output.error).toBe("Invalid or unsafe image URL");
        expect(output.code).toBeUndefined();
        expect(state.log).toStrictEqual([]);
    });

    it("needs a signed-in user before anything is charged", async () => {
        const output = await tool.execute({ ...makeContext(), userId: undefined }, edit);

        expect(output.error).toBe("Authentication required");
        expect(state.log).toStrictEqual([]);
    });
});
