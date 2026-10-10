/**
 * Organization-shared skills in the chat pipeline: a member of the owning
 * organization gets them once they opt in, nobody else ever does. Driven through the real executor
 * functions against an in-memory stand-in for the two tables they read.
 */
import { describe, expect, it } from "vitest";

import type { QueryCtx as QueryContext } from "../_generated/server";
import { getEnabledSkillsForSystemPrompt, loadSkillForInvocation } from "./executor";

interface SkillRow {
    _id: string;
    description: string;
    instructions: string;
    name: string;
    organizationId?: string;
    slug: string;
    userId: string;
    visibility?: string;
}

interface UserSkillRow {
    enabled: boolean;
    skillId: string;
    userId: string;
}

const matches = (row: object, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value);

const fakeContext = (skills: SkillRow[], userSkills: UserSkillRow[] = []): QueryContext => {
    const userSkillsQuery = () => {
        return {
            withIndex: (_index: string, build: (q: unknown) => unknown) => {
                const where: Record<string, unknown> = {};
                const q = {
                    eq: (field: string, value: unknown) => {
                        where[field] = value;

                        return q;
                    },
                };

                build(q);

                const rows = userSkills.filter((row) => matches(row, where));

                return {
                    collect: async () => rows,
                    first: async () => rows[0] ?? null,
                    take: async (n: number) => rows.slice(0, n),
                };
            },
        };
    };

    return {
        db: {
            get: async (id: string) => skills.find((skill) => skill._id === id) ?? null,
            query: userSkillsQuery,
            skills: {
                findFirst: async ({ where }: { where: Record<string, unknown> }) => skills.find((skill) => matches(skill, where)) ?? null,
                findMany: async ({ limit, where }: { limit: number; where: Record<string, unknown> }) => {
                    return { page: skills.filter((skill) => matches(skill, where)).slice(0, limit) };
                },
                get: async (id: string) => skills.find((skill) => skill._id === id) ?? null,
            },
        },
    } as unknown as QueryContext;
};

const orgShared: SkillRow = {
    _id: "skill-org",
    description: "Team review checklist",
    instructions: "Review against the team checklist",
    name: "Team review",
    organizationId: "org-x",
    slug: "team-review",
    userId: "owner",
    visibility: "organization",
};

const orgPrivate: SkillRow = { ...orgShared, _id: "skill-private", slug: "owner-notes", visibility: "private" };

describe("organization-shared skills", () => {
    it("stay out of a member's prompt until the member enables them", async () => {
        const context = fakeContext([orgShared, orgPrivate]);

        await expect(getEnabledSkillsForSystemPrompt(context, "member", "org-x")).resolves.toStrictEqual([]);
        await expect(loadSkillForInvocation(context, "member", "team-review", "", "org-x")).rejects.toThrow("not enabled");
    });

    it("reach a member of the organization who enabled them", async () => {
        const context = fakeContext([orgShared, orgPrivate], [{ enabled: true, skillId: "skill-org", userId: "member" }]);

        await expect(getEnabledSkillsForSystemPrompt(context, "member", "org-x")).resolves.toStrictEqual([
            { description: "Team review checklist", name: "Team review", slug: "team-review" },
        ]);
        await expect(loadSkillForInvocation(context, "member", "team-review", "", "org-x")).resolves.toMatchObject({ skillId: "skill-org" });
    });

    it("drop out once the member switches to another organization", async () => {
        const context = fakeContext([orgShared], [{ enabled: true, skillId: "skill-org", userId: "member" }]);

        await expect(getEnabledSkillsForSystemPrompt(context, "member", "org-y")).resolves.toStrictEqual([]);
        await expect(loadSkillForInvocation(context, "member", "team-review", "", "org-y")).resolves.toBeNull();
    });

    it("do not reach a member of another organization, or a caller with no organization", async () => {
        const context = fakeContext([orgShared, orgPrivate]);

        for (const organizationId of ["org-y", undefined]) {
            await expect(getEnabledSkillsForSystemPrompt(context, "stranger", organizationId)).resolves.toStrictEqual([]);
            await expect(loadSkillForInvocation(context, "stranger", "team-review", "", organizationId)).resolves.toBeNull();
        }
    });

    it("never expose a private skill that merely carries the organization id", async () => {
        const context = fakeContext([orgPrivate]);

        await expect(getEnabledSkillsForSystemPrompt(context, "member", "org-x")).resolves.toStrictEqual([]);
        await expect(loadSkillForInvocation(context, "member", "owner-notes", "", "org-x")).resolves.toBeNull();
    });

    it("drop out once the member disables them", async () => {
        const context = fakeContext([orgShared], [{ enabled: false, skillId: "skill-org", userId: "member" }]);

        await expect(getEnabledSkillsForSystemPrompt(context, "member", "org-x")).resolves.toStrictEqual([]);
        await expect(loadSkillForInvocation(context, "member", "team-review", "", "org-x")).rejects.toThrow("not enabled");
    });

    it("stop reaching an installer once the owner makes a public skill private", async () => {
        const context = fakeContext(
            [{ ...orgShared, organizationId: undefined, visibility: "private" }],
            [{ enabled: true, skillId: "skill-org", userId: "installer" }],
        );

        await expect(getEnabledSkillsForSystemPrompt(context, "installer")).resolves.toStrictEqual([]);
        await expect(loadSkillForInvocation(context, "installer", "team-review")).resolves.toBeNull();
    });
});
