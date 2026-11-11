import { describe, expect, it } from "vitest";

import type { PlanEntry } from "../skills/bundle-plan";
import { entryHash, skillRowHash, triggerRowHash } from "./entry-hash";

const TRIGGER = { cronExpression: "0 9 * * *", model: "claude-haiku-5-5", name: "Daily", type: "schedule" };

/** A plan entry with a trigger create, as the planner produces it. */
const triggerEntry = (create: typeof TRIGGER): PlanEntry =>
    ({
        key: "trigger:0",
        kind: "trigger",
        plan: { create, kind: "trigger" },
        problems: [],
        requires: [],
        title: "Daily",
        warnings: [],
    }) as unknown as PlanEntry;

describe("a trigger's live hash", () => {
    it("matches the hash of its file entry when the row stores the same content", async () => {
        expect(await triggerRowHash(TRIGGER)).toBe(await entryHash(triggerEntry(TRIGGER)));
    });

    it("changes when the row's schedule is edited", async () => {
        expect(await triggerRowHash({ ...TRIGGER, cronExpression: "0 10 * * *" })).not.toBe(await entryHash(triggerEntry(TRIGGER)));
    });

    it("ignores the row's own fields, which are not content", async () => {
        expect(await triggerRowHash({ ...TRIGGER, enabled: true, triggerCount: 4, userId: "owner" } as typeof TRIGGER)).toBe(
            await entryHash(triggerEntry(TRIGGER)),
        );
    });
});

describe("a skill's live hash", () => {
    it("ignores the row's owner and flags", async () => {
        const fields = { description: "A", instructions: "B", name: "C", slug: "c" };

        expect(await skillRowHash({ ...fields, userId: "owner", visibility: "private" } as typeof fields)).toBe(await skillRowHash(fields));
    });
});
