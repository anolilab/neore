import { describe, expect, it } from "vitest";

import { scrub } from "./process";
import type { SpawnPlan } from "./types";

const planWith = (env: Record<string, string>): SpawnPlan => ({ env, secretNames: Object.keys(env) }) as unknown as SpawnPlan;

describe("scrub", () => {
    it("masks the longer of two overlapping secrets in full, not only its shorter prefix", () => {
        const plan = planWith({ LONG_KEY: "sk-abcdef-tail", SHORT_KEY: "sk-abcd" });

        expect(scrub("the agent echoed sk-abcdef-tail", plan)).toBe("the agent echoed ***");
    });
});
