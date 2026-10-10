import { describe, expect, it } from "vitest";

import type { CanaryConfig } from "../routing/canary.js";
import { getCanaryModel, loadCanaryConfigs, saveCanaryConfigs } from "../routing/canary.js";

// ── KV stub ────────────────────────────────────────────────────────────────

function makeKv(initial: unknown = null): KVNamespace {
    let stored: unknown = initial;

    return {
        async delete(_key: string) {
            stored = null;
        },
        async get(_key: string, type?: string) {
            if (stored === null) return null;

            if (type === "json") return stored;

            return JSON.stringify(stored);
        },
        async getWithMetadata() {
            return { metadata: null, value: null };
        },
        async list() {
            return { cursor: "", keys: [], list_complete: true };
        },
        async put(_key: string, value: string) {
            try {
                stored = JSON.parse(value);
            } catch {
                stored = value;
            }
        },
    } as unknown as KVNamespace;
}

function makeConfig(overrides: Partial<CanaryConfig> = {}): CanaryConfig {
    return {
        canaryModelId: "claude-3-5-sonnet",
        id: "test-id",
        isActive: true,
        primaryModelId: "gpt-4o",
        splitPercent: 50,
        startedAt: Date.now(),
        ...overrides,
    };
}

// ── loadCanaryConfigs ──────────────────────────────────────────────────────

describe("loadCanaryConfigs", () => {
    it("returns empty array when KV is empty", async () => {
        const kv = makeKv(null);

        expect(await loadCanaryConfigs(kv)).toEqual([]);
    });

    it("returns active configs", async () => {
        const config = makeConfig();
        const kv = makeKv([config]);
        const result = await loadCanaryConfigs(kv);

        expect(result).toHaveLength(1);
        expect(result[0]!.id).toBe("test-id");
    });

    it("filters out inactive configs", async () => {
        const config = makeConfig({ isActive: false });
        const kv = makeKv([config]);

        expect(await loadCanaryConfigs(kv)).toHaveLength(0);
    });

    it("filters out expired configs (endsAt in the past)", async () => {
        const config = makeConfig({ endsAt: Date.now() - 1000 });
        const kv = makeKv([config]);

        expect(await loadCanaryConfigs(kv)).toHaveLength(0);
    });

    it("keeps configs where endsAt is in the future", async () => {
        const config = makeConfig({ endsAt: Date.now() + 60_000 });
        const kv = makeKv([config]);

        expect(await loadCanaryConfigs(kv)).toHaveLength(1);
    });

    it("returns empty array on KV error", async () => {
        const kv = {
            async get() {
                throw new Error("KV read failure");
            },
        } as unknown as KVNamespace;

        expect(await loadCanaryConfigs(kv)).toEqual([]);
    });
});

// ── saveCanaryConfigs ──────────────────────────────────────────────────────

describe("saveCanaryConfigs", () => {
    it("persists configs to KV", async () => {
        const kv = makeKv(null);
        const config = makeConfig();

        await saveCanaryConfigs(kv, [config]);

        const loaded = await loadCanaryConfigs(kv);

        expect(loaded).toHaveLength(1);
        expect(loaded[0]!.id).toBe("test-id");
    });
});

// ── getCanaryModel ─────────────────────────────────────────────────────────

describe("getCanaryModel", () => {
    it("returns null when no canary configs exist", async () => {
        const kv = makeKv(null);

        expect(await getCanaryModel("gpt-4o", "user-1", undefined, kv)).toBeNull();
    });

    it("returns null when primaryModelId does not match", async () => {
        const config = makeConfig({ primaryModelId: "claude-3-5-sonnet", splitPercent: 100 });
        const kv = makeKv([config]);

        expect(await getCanaryModel("gpt-4o", "user-1", undefined, kv)).toBeNull();
    });

    it("routes to canary model when splitPercent is 100", async () => {
        const config = makeConfig({ splitPercent: 100 });
        const kv = makeKv([config]);
        const result = await getCanaryModel("gpt-4o", "user-1", undefined, kv);

        expect(result).not.toBeNull();
        expect(result!.modelId).toBe("claude-3-5-sonnet");
        expect(result!.canaryId).toBe("test-id");
    });

    it("never routes to canary when splitPercent is 0", async () => {
        const config = makeConfig({ splitPercent: 0 });
        const kv = makeKv([config]);

        // Run 100 times — should always be null
        for (let i = 0; i < 100; i++) {
            expect(await getCanaryModel("gpt-4o", "user-1", undefined, kv)).toBeNull();
        }
    });

    it("respects userId scope — skips if userId does not match", async () => {
        const config = makeConfig({ splitPercent: 100, userId: "user-A" });
        const kv = makeKv([config]);

        expect(await getCanaryModel("gpt-4o", "user-B", undefined, kv)).toBeNull();
    });

    it("respects userId scope — applies if userId matches", async () => {
        const config = makeConfig({ splitPercent: 100, userId: "user-A" });
        const kv = makeKv([config]);
        const result = await getCanaryModel("gpt-4o", "user-A", undefined, kv);

        expect(result).not.toBeNull();
    });

    it("respects orgId scope — skips if orgId does not match", async () => {
        const config = makeConfig({ orgId: "org-X", splitPercent: 100 });
        const kv = makeKv([config]);

        expect(await getCanaryModel("gpt-4o", "user-1", "org-Y", kv)).toBeNull();
    });

    it("respects orgId scope — applies if orgId matches", async () => {
        const config = makeConfig({ orgId: "org-X", splitPercent: 100 });
        const kv = makeKv([config]);
        const result = await getCanaryModel("gpt-4o", "user-1", "org-X", kv);

        expect(result).not.toBeNull();
    });

    it.each([{ splitPercent: 10 }, { splitPercent: 50 }, { splitPercent: 90 }])(
        "statistical distribution: splitPercent:$splitPercent routes ~$splitPercent% over 1000 calls (±5%)",
        async ({ splitPercent }) => {
            const config = makeConfig({ splitPercent });
            const kv = makeKv([config]);

            const SAMPLES = 1000;
            let canaryCount = 0;

            for (let i = 0; i < SAMPLES; i++) {
                const result = await getCanaryModel("gpt-4o", "user-1", undefined, kv);

                if (result !== null) canaryCount++;
            }

            const actualPercent = (canaryCount / SAMPLES) * 100;

            // Expect within ±5 percentage points of the configured split.
            expect(actualPercent).toBeGreaterThanOrEqual(splitPercent - 5);
            expect(actualPercent).toBeLessThanOrEqual(splitPercent + 5);
        },
    );
});
