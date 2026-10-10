import { describe, expect, it } from "vitest";

import { getRateLimitKey, RATE_LIMIT_CONFIGS } from "../lib/rate-limiter";
import { ANONYMOUS_TASKS_MESSAGE, roundQuotaKeys, taskAccessProblem } from "./account";

describe(taskAccessProblem, () => {
    it("refuses an anonymous or missing account and allows a real one", () => {
        expect(taskAccessProblem({ isAdmin: false, isAnonymous: true, tier: "free" })).toBe(ANONYMOUS_TASKS_MESSAGE);
        expect(taskAccessProblem(null)).toEqual(expect.any(String));
        expect(taskAccessProblem({ isAdmin: false, isAnonymous: false, tier: "free" })).toBeUndefined();
    });
});

describe(roundQuotaKeys, () => {
    it("charges the chat message limit and the tasks limit, for both tiers, and exempts admins", () => {
        for (const tier of ["free", "premium"] as const) {
            const keys = roundQuotaKeys({ isAdmin: false, isAnonymous: false, tier });

            expect(keys).toStrictEqual([`chat/dailyText:${tier}`, `tasks/dailyRuns:${tier}`]);

            // An unknown key would make `createRatelimit` throw on every claim.
            for (const key of keys) {
                expect(Object.hasOwn(RATE_LIMIT_CONFIGS, key), key).toBe(true);
            }
        }

        expect(roundQuotaKeys({ isAdmin: true, isAnonymous: false, tier: "free" })).toStrictEqual([]);
    });

    it("keeps the tasks ceiling at or under the chat allowance it shares", () => {
        for (const tier of ["free", "premium"] as const) {
            expect(RATE_LIMIT_CONFIGS[getRateLimitKey("tasks/dailyRuns", tier)].rate).toBeLessThanOrEqual(RATE_LIMIT_CONFIGS[`chat/dailyText:${tier}`].rate);
        }
    });
});
