/**
 * Skills created for a group chat template (`chat/group/templates.ts`).
 *
 * Lives in the skills module, which owns `skills`, `skillStats`, `userSkills`
 * and `skillHistory` (`skills/module.ts`). `createGroupChatFromTemplate`
 * (`chat/group/functions.ts`) calls it inside its own mutation, so the skill
 * rows and the group thread are written in ONE transaction, exactly as before
 * it moved here.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx as MutationContext } from "../_generated/server";
import { invalidateSkillsCache } from "./cache";
import { FREE_SKILL_LIMIT } from "./constants";

/** A template persona — structurally `GroupTemplatePersona`. */
export interface TemplatePersona {
    description: string;
    icon: string;
    instructions: string;
    name: string;
    /** Namespaced, so a template never adopts an unrelated skill of the user's. */
    slug: string;
}

/**
 * The caller's skill for each template persona, in order: the one they already
 * own under that slug (kept as they left it, and enabled), otherwise a new
 * private copy — created, enabled and counted against the free skill limit
 * exactly as `skills_functions.createSkill` does.
 */
export const ensureTemplateSkills = async (
    ctx: Pick<MutationContext, "db" | "runMutation" | "scheduler">,
    user: { activeOrganizationId?: string; isPremium: boolean; userId: string },
    personas: ReadonlyArray<TemplatePersona>,
): Promise<string[]> => {
    const { userId } = user;
    const existing = await Promise.all(personas.map(async (persona) => await ctx.db.skills.findFirst({ where: { slug: persona.slug, userId } })));
    const missing = personas.filter((_, index) => !existing[index]);

    if (missing.length > 0 && !user.isPremium) {
        // The caller's own rows, read through the owner policy; `count()` cannot run behind it.
        const owned = await ctx.db.skills.findMany({ limit: FREE_SKILL_LIMIT + 1, where: { userId } });

        if (owned.page.length + missing.length > FREE_SKILL_LIMIT) {
            throw new LunoraError(
                "UNPROCESSABLE",
                `This template adds ${String(missing.length)} skills, and free accounts are limited to ${String(FREE_SKILL_LIMIT)}. Upgrade to Pro for unlimited skills.`,
            );
        }
    }

    const now = Date.now();
    const skillIds = await Promise.all(
        personas.map(async (persona, index) => {
            const found = existing[index];

            if (found) {
                const link = await ctx.db
                    .query("userSkills")
                    .withIndex("by_user_and_skill", (q) => q.eq("userId", userId).eq("skillId", found._id))
                    .first();

                if (!link) {
                    await ctx.db.insert("userSkills", { addedAt: now, autoRun: false, enabled: true, skillId: found._id, userId });
                } else if (!link.enabled) {
                    await ctx.db.patch(link._id, { enabled: true });
                }

                return found._id as string;
            }

            const skillId = (await ctx.db.insert("skills", {
                currentVersion: 1,
                description: persona.description,
                icon: persona.icon,
                instructions: persona.instructions,
                name: persona.name,
                ...(user.activeOrganizationId && { organizationId: user.activeOrganizationId }),
                slug: persona.slug,
                source: { type: "editor" },
                tags: ["group-template"],
                updatedAt: now,
                userId,
                visibility: "private",
            })) as Id<"skills">;

            await ctx.db.insert("skillStats", { skillId, usageCount: 0 });
            await ctx.db.insert("userSkills", { addedAt: now, autoRun: false, enabled: true, skillId, userId });
            await ctx.db.insert("skillHistory", {
                changeType: "created",
                createdAt: now,
                instructions: persona.instructions,
                note: "Created from a group chat template",
                skillId,
                userId,
                version: 1,
            });

            return skillId as string;
        }),
    );

    await invalidateSkillsCache(ctx as MutationContext, userId);

    return skillIds;
};
