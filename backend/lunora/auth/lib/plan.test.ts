import { describe, expect, it } from "vitest";

import { resolveUserPlan } from "./plan";

describe(resolveUserPlan, () => {
    it("is premium for the user's own Pro, with no organization at all", () => {
        expect(resolveUserPlan({ baseTier: "pro" }, [])).toBe("premium");
    });

    it("is premium while an organization that counts is on a paid tier", () => {
        expect(resolveUserPlan({}, [{ baseTier: "pro" }])).toBe("premium");
        expect(resolveUserPlan({}, [{ baseTier: "enterprise" }])).toBe("premium");
        expect(resolveUserPlan(null, [{ baseTier: "free" }, { baseTier: "pro" }])).toBe("premium");
    });

    it("is free otherwise", () => {
        expect(resolveUserPlan({ baseTier: "free" }, [{ baseTier: "free" }])).toBeNull();
        expect(resolveUserPlan({}, [{}, null, undefined])).toBeNull();
        expect(resolveUserPlan(null, [])).toBeNull();
    });

    it("makes only the buyer premium when one member of a 10-person organization buys Pro", () => {
        const organization = { baseTier: "free" as const };
        const members = Array.from({ length: 10 }, (_, index) => (index === 0 ? { baseTier: "pro" as const } : {}));

        const plans = members.map((member) => resolveUserPlan(member, [organization]));

        expect(plans[0]).toBe("premium");
        expect(plans.filter((plan) => plan === "premium")).toHaveLength(1);
    });
});
