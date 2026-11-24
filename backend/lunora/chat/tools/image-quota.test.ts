/**
 * A member's image allowance is read and charged on the member's own shard, even when the tool runs on the thread owner's.
 * The member's row lives there, so a read on the owner's shard would see no paid plan and pick the free bucket.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runInShard } from "../../lib/shard-context";

const crossShard = vi.hoisted(() => {
    return { calls: [] as { args: unknown; reference: string; shardKey: string }[] };
});

vi.mock("../../lib/cross-shard", () => {
    return {
        callOnShard: async (reference: string, args: unknown, options: { shardKey: string }) => {
            crossShard.calls.push({ args, reference, shardKey: options.shardKey });

            if (reference === "getUserAuthFlagsQuery") {
                return { isAnonymous: false, plan: "premium", role: null };
            }

            return reference === "applyRateLimit" ? { ok: true } : undefined;
        },
    };
});
vi.mock("../../_generated/internal", () => {
    return {
        internal: {
            auth: {
                billing: { getRunPlanForOrganizationQuery: "getRunPlanForOrganizationQuery" },
                functions: { getUserAuthFlagsQuery: "getUserAuthFlagsQuery" },
            },
            chat: { daily_charge: { chargeDailyLimitOnce: "chargeDailyLimitOnce", refundDailyCharge: "refundDailyCharge" } },
            lib: { rate_limiter_mutations: { applyRateLimit: "applyRateLimit" } },
        },
    };
});

const { takeImageQuota } = await import("./image-quota");

/** The owner's shard holds no paid plan for the member: a read there would answer free. */
const makeContext = () => {
    async function runQuery(reference: string) {
        return reference === "getUserAuthFlagsQuery" ? { isAnonymous: false, plan: null, role: null } : undefined;
    }

    async function runMutation() {
        return { ok: true };
    }

    return { organizationId: undefined, runMutation, runQuery } as never;
};

beforeEach(() => {
    crossShard.calls.length = 0;
});

describe("image allowance is read on the user's own shard", () => {
    it("reads the member's flags and charges their premium bucket, both on the member's shard", async () => {
        const result = await runInShard("owner-1", async () => await takeImageQuota(makeContext(), "member-1", 1));

        expect(result.ok).toBe(true);
        expect(crossShard.calls.map((call) => [call.reference, call.shardKey])).toStrictEqual([
            ["getUserAuthFlagsQuery", "member-1"],
            ["applyRateLimit", "member-1"],
        ]);
        expect(crossShard.calls[1]?.args).toMatchObject({ count: 1, identifier: "member-1", key: "chat/dailyImage:premium" });
    });

    it("reads and charges locally, with no crossing, when no shard is entered", async () => {
        const result = await takeImageQuota(makeContext(), "member-1", 1);

        expect(result.ok).toBe(true);
        expect(crossShard.calls).toHaveLength(0);
    });
});
