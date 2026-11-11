import { describe, expect, it } from "vitest";

import { collectAcpSessionPages } from "../acp/gdpr";
import {
    ACP_READ_BYTES,
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
    it("caps the coding-agent sessions below the action's budget, keeping the margin for the sections after them", () => {
        expect(ACP_READ_BYTES).toBe(ACTION_READ_BYTES - READ_MARGIN_BYTES);
        // Sessions at their cap, then the repositories' floor, still fit the action's budget; the triggers get nothing.
        expect(ACP_READ_BYTES + repositoriesReadBudget(ACP_READ_BYTES)).toBeLessThanOrEqual(ACTION_READ_BYTES);
        expect(triggerReadBudget(ACP_READ_BYTES + REPOSITORIES_READ_FLOOR_BYTES)).toBe(0);
    });

    it("exports a session history right at the cap, and fails one byte over it rather than reading past the budget", async () => {
        const page = (text: string) => {
            return { events: [], sessions: [{ text }] };
        };
        // The page's own JSON around the text, so the history is exactly `ACP_READ_BYTES` long.
        const overhead = JSON.stringify(page("")).length;
        const atCap = page("x".repeat(ACP_READ_BYTES - overhead));

        await expect(collectAcpSessionPages(async () => atCap, ACP_READ_BYTES)).resolves.toMatchObject({ sessions: [{ text: expect.any(String) }] });
        await expect(collectAcpSessionPages(async () => page("x".repeat(ACP_READ_BYTES - overhead + 1)), ACP_READ_BYTES)).rejects.toMatchObject({
            code: "PAYLOAD_TOO_LARGE",
        });
    }, 30_000);

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
