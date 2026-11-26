import { describe, expect, it } from "vitest";

import type { PlanEntry } from "../skills/bundle-plan";
import { entryHash, groupRowHash, skillRowHash, triggerRowHash } from "./entry-hash";

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

describe("a group's live hash", () => {
    const GROUP = { mode: "round-robin", model: "claude-haiku-5-5", participantKeys: ["skill:0", "skill:1"], title: "Panel" };
    const groupEntry = (create: typeof GROUP): PlanEntry =>
        ({ key: "group:0", kind: "group", plan: { create, kind: "group" }, problems: [], requires: [], title: "Panel", warnings: [] }) as unknown as PlanEntry;
    const keyOf = (skillId: string) => ({ A: "skill:0", B: "skill:1" })[skillId];
    const row = (participants: string[], title = "Panel") => ({
        mode: "round-robin",
        model: "claude-haiku-5-5",
        participants: participants.map((skillId) => ({ skillId })),
        title,
    });

    it("matches the file's group when every participant is the plugin's own skill", async () => {
        expect(await groupRowHash(row(["A", "B"]), keyOf)).toBe(await entryHash(groupEntry(GROUP)));
    });

    it("changes when a participant is swapped for a skill the plugin does not own", async () => {
        expect(await groupRowHash(row(["A", "Z"]), keyOf)).not.toBe(await entryHash(groupEntry(GROUP)));
    });

    it("reads an empty title as the default on both sides, so an unedited untitled group still matches", async () => {
        expect(await groupRowHash(row(["A", "B"], "Group chat"), keyOf)).toBe(await entryHash(groupEntry({ ...GROUP, title: "" })));
    });
});
