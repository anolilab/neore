/**
 * A task assigned an organization-shared skill resolves it only while its owner
 * is still a member of that organization — re-checked on every run, because the
 * headless runner has no session to re-derive membership from.
 *
 * `skills` and `member` are `.global()` tables the harness cannot back, so the
 * real resolver runs against an in-memory stand-in (as `skills/executor.test.ts`
 * does).
 */
import { describe, expect, it } from "vitest";

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveTaskSkillForRun } from "./internal";

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => row[key] === value);

const fakeContext = (tables: { member: Row[]; skills: Row[]; userSkills: Row[] }): QueryCtx => {
    const facade = (rows: Row[]) => {
        return {
            findFirst: async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null,
            findMany: async ({ limit, where }: { limit?: number; where: Row }) => {
                return { page: rows.filter((row) => matches(row, where)).slice(0, limit) };
            },
        };
    };

    return {
        db: {
            get: async (id: string) => tables.skills.find((skill) => skill._id === id) ?? null,
            member: facade(tables.member),
            query: () => {
                return {
                    withIndex: (_index: string, build: (q: unknown) => unknown) => {
                        const where: Row = {};
                        const q = {
                            eq: (field: string, value: unknown) => {
                                where[field] = value;

                                return q;
                            },
                        };

                        build(q);

                        const rows = tables.userSkills.filter((row) => matches(row, where));

                        return { first: async () => rows[0] ?? null, take: async (n: number) => rows.slice(0, n) };
                    },
                };
            },
            skills: facade(tables.skills),
        },
    } as unknown as QueryCtx;
};

const SKILL_ID = "skill-org" as Id<"skills">;

const sharedSkill: Row = {
    _id: SKILL_ID,
    description: "Team checklist",
    instructions: "Review against the team checklist",
    name: "Team review",
    organizationId: "org-x",
    slug: "team-review",
    userId: "owner",
    visibility: "organization",
};

const enabled: Row = { enabled: true, skillId: SKILL_ID, userId: "member-a" };

describe(resolveTaskSkillForRun, () => {
    it("resolves an organization-shared skill for a current member", async () => {
        const ctx = fakeContext({ member: [{ organizationId: "org-x", role: "member", userId: "member-a" }], skills: [sharedSkill], userSkills: [enabled] });

        await expect(resolveTaskSkillForRun(ctx, { organizationId: "org-x", skillId: SKILL_ID, userId: "member-a" })).resolves.toStrictEqual({
            config: undefined,
            instructions: "Review against the team checklist",
            slug: "team-review",
        });
    });

    it("refuses it once the owner of the task has left the organization", async () => {
        const ctx = fakeContext({ member: [], skills: [sharedSkill], userSkills: [enabled] });

        await expect(resolveTaskSkillForRun(ctx, { organizationId: "org-x", skillId: SKILL_ID, userId: "member-a" })).resolves.toStrictEqual({
            error: "The assigned skill no longer exists or is not available to you.",
        });
    });

    it("refuses it when the task was saved outside that organization", async () => {
        const ctx = fakeContext({ member: [{ organizationId: "org-y", role: "member", userId: "member-a" }], skills: [sharedSkill], userSkills: [enabled] });

        await expect(resolveTaskSkillForRun(ctx, { organizationId: "org-y", skillId: SKILL_ID, userId: "member-a" })).resolves.toHaveProperty("error");
        await expect(resolveTaskSkillForRun(ctx, { skillId: SKILL_ID, userId: "member-a" })).resolves.toHaveProperty("error");
    });

    it("still resolves the user's own skill without any organization", async () => {
        const own = { ...sharedSkill, organizationId: undefined, userId: "member-a", visibility: "private" };
        const ctx = fakeContext({ member: [], skills: [own], userSkills: [enabled] });

        await expect(resolveTaskSkillForRun(ctx, { skillId: SKILL_ID, userId: "member-a" })).resolves.toHaveProperty("instructions");
    });
});
