import { describe, expect, it } from "vitest";

import {
    ACTION_READ_BYTES,
    projectDetailsReadBudget,
    REPOSITORIES_READ_FLOOR_BYTES,
    repositoriesReadBudget,
    READ_MARGIN_BYTES,
    TRIGGER_READ_BYTES,
    triggerReadBudget,
} from "./read-budget";

const MIB = 1024 * 1024;

describe("export read budget", () => {
    it("leaves the trigger history only what the ACP sessions and repositories did not read", () => {
        // 4 MiB of ACP sessions and 20 MB of repository rows: the triggers may read 0 MiB, not 12, so the action stays
        // inside one request's budget.
        const used = 4 * MIB + 20 * MIB;

        expect(used + triggerReadBudget(used) + READ_MARGIN_BYTES).toBeLessThanOrEqual(ACTION_READ_BYTES);
        expect(triggerReadBudget(0)).toBe(TRIGGER_READ_BYTES);
    });

    it("gives the repositories what is left after earlier sections, never less than a small floor", () => {
        expect(repositoriesReadBudget(4 * MIB)).toBe(ACTION_READ_BYTES - 4 * MIB - READ_MARGIN_BYTES);
        expect(repositoriesReadBudget(ACTION_READ_BYTES)).toBe(REPOSITORIES_READ_FLOOR_BYTES);
    });

    it("gives the projects' details no floor: once earlier sections used the budget, they read nothing", () => {
        expect(projectDetailsReadBudget(4 * MIB)).toBe(ACTION_READ_BYTES - 4 * MIB - READ_MARGIN_BYTES);
        expect(projectDetailsReadBudget(ACTION_READ_BYTES - READ_MARGIN_BYTES)).toBe(0);
    });
});
