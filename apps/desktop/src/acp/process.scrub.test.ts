import { describe, expect, it } from "vitest";

import { scrub } from "./process";
import type { SpawnPlan } from "./types";

const planWith = (env: Record<string, string>): SpawnPlan => ({ env, secretNames: Object.keys(env) }) as unknown as SpawnPlan;

describe("scrub", () => {
    it("masks the longer of two overlapping secrets in full, not only its shorter prefix", () => {
        // The shorter value is listed first: replacing in the variables' own order would leave the longer one's tail.
        const plan = planWith({ A_SHORT_KEY: "sk-abcd", B_LONG_KEY: "sk-abcdef-tail" });

        expect(scrub("the agent echoed sk-abcdef-tail", plan)).toBe("the agent echoed ***");
    });
});
