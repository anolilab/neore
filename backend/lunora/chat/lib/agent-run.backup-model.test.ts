import { MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { resolveBackupModelId } from "./agent-run";

vi.mock("./get-agent", () => {
    return { default: vi.fn() };
});
vi.mock("./agent-tools", () => {
    return { buildAgentTools: vi.fn() };
});

const PAID_MODEL = "anthropic/claude-opus-4.6";
const FREE_MODEL = "moonshotai/kimi-k2-0905";
const OTHER_FREE_MODEL = "openai/gpt-4.1-mini";

const makeCtx = ({ plan = null, storedRules }: { plan?: "premium" | null; storedRules?: Record<string, string[]> } = {}) => {
    return {
        runQuery: vi.fn(async (reference: unknown) => {
            if (reference === internal.auth.functions.getUserRunPlanQuery) {
                return { isAdmin: false, plan };
            }

            if (reference === internal.auth.functions.getAgentModulePreferencesQuery) {
                return { modelFilterRules: storedRules };
            }

            if (reference === internal.auth.functions.getDecryptedProviderKeysQuery) {
                return {};
            }

            throw new Error("unexpected query");
        }),
    };
};

describe("resolveBackupModelId", () => {
    it("returns a free model other than the run's own", async () => {
        expect(MODEL_REGISTRY.some((m) => m.id === OTHER_FREE_MODEL)).toBe(true);
        await expect(resolveBackupModelId(makeCtx(), "u1", OTHER_FREE_MODEL, FREE_MODEL)).resolves.toBe(OTHER_FREE_MODEL);
    });

    it("is none for a custom endpoint, which is never wrapped for a fallback", async () => {
        await expect(resolveBackupModelId(makeCtx(), "u1", OTHER_FREE_MODEL, "custom:abc/some-model")).resolves.toBeUndefined();
    });

    it("is none when unset, stale or the run's own model", async () => {
        await expect(resolveBackupModelId(makeCtx(), "u1", undefined, FREE_MODEL)).resolves.toBeUndefined();
        await expect(resolveBackupModelId(makeCtx(), "u1", "no-such-model", FREE_MODEL)).resolves.toBeUndefined();
        await expect(resolveBackupModelId(makeCtx(), "u1", FREE_MODEL, FREE_MODEL)).resolves.toBeUndefined();
    });

    it("is none when the user's model filters exclude it, as the gateway would answer MODEL_BLOCKED", async () => {
        await expect(resolveBackupModelId(makeCtx(), "u1", OTHER_FREE_MODEL, FREE_MODEL, { blockedModels: [OTHER_FREE_MODEL] })).resolves.toBeUndefined();
        await expect(
            resolveBackupModelId(makeCtx(), "u1", OTHER_FREE_MODEL, FREE_MODEL, {
                blockedProviders: [MODEL_REGISTRY.find((m) => m.id === OTHER_FREE_MODEL)!.provider],
            }),
        ).resolves.toBeUndefined();
        await expect(resolveBackupModelId(makeCtx(), "u1", OTHER_FREE_MODEL, FREE_MODEL, { allowedModels: [FREE_MODEL] })).resolves.toBeUndefined();
        await expect(resolveBackupModelId(makeCtx(), "u1", OTHER_FREE_MODEL, FREE_MODEL, { blockedModels: [FREE_MODEL] })).resolves.toBe(OTHER_FREE_MODEL);
    });

    it("applies the user's stored filters when the caller passes none (group, headless and continuation runs)", async () => {
        const blocked = makeCtx({ storedRules: { blockedModels: [OTHER_FREE_MODEL] } });

        await expect(resolveBackupModelId(blocked, "u1", OTHER_FREE_MODEL, FREE_MODEL)).resolves.toBeUndefined();
        expect(blocked.runQuery).toHaveBeenCalledWith(internal.auth.functions.getAgentModulePreferencesQuery, { userId: "u1" });
        await expect(resolveBackupModelId(makeCtx({ storedRules: { blockedModels: [FREE_MODEL] } }), "u1", OTHER_FREE_MODEL, FREE_MODEL)).resolves.toBe(
            OTHER_FREE_MODEL,
        );
    });

    it("does not open a paid model to a user whose plan cannot run it", async () => {
        await expect(resolveBackupModelId(makeCtx(), "u1", PAID_MODEL, FREE_MODEL)).resolves.toBeUndefined();
        await expect(resolveBackupModelId(makeCtx({ plan: "premium" }), "u1", PAID_MODEL, FREE_MODEL)).resolves.toBe(PAID_MODEL);
    });
});
