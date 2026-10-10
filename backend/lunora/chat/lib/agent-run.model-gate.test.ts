import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { resolveRunModel } from "./agent-run";

vi.mock("./get-agent", () => {
    return { default: vi.fn() };
});
vi.mock("./agent-tools", () => {
    return { buildAgentTools: vi.fn() };
});

const PAID_MODEL = "anthropic/claude-opus-4.6";
const FREE_MODEL = "moonshotai/kimi-k2-0905";

const makeCtx = ({ isAdmin = false, keys = {}, plan = null }: { isAdmin?: boolean; keys?: Record<string, string>; plan?: "premium" | null }) => {
    return {
        runQuery: vi.fn(async (reference: unknown) => {
            if (reference === internal.auth.functions.getUserRunPlanQuery) {
                return { isAdmin, plan };
            }

            if (reference === internal.auth.functions.getDecryptedProviderKeysQuery) {
                return keys;
            }

            throw new Error("unexpected query");
        }),
    };
};

describe("resolveRunModel plan gate", () => {
    it("runs a free-tier model without looking up the plan", async () => {
        const ctx = makeCtx({});

        await expect(resolveRunModel(ctx, FREE_MODEL, "u1")).resolves.toMatchObject({ allowTools: true });
        expect(ctx.runQuery).not.toHaveBeenCalled();
    });

    it("refuses a paid model to a free user without their own key", async () => {
        await expect(resolveRunModel(makeCtx({}), PAID_MODEL, "u1")).rejects.toMatchObject({ kind: "plan-required" });
    });

    it("lets a paid plan, an admin, or the user's own provider key through", async () => {
        await expect(resolveRunModel(makeCtx({ plan: "premium" }), PAID_MODEL, "u1")).resolves.toMatchObject({ allowTools: true });
        await expect(resolveRunModel(makeCtx({ isAdmin: true }), PAID_MODEL, "u1")).resolves.toMatchObject({ allowTools: true });
        await expect(resolveRunModel(makeCtx({ keys: { openrouter: "sk-or-test" } }), PAID_MODEL, "u1")).resolves.toMatchObject({ allowTools: true });
    });
});
