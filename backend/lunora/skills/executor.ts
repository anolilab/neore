/**
 * Skills executor - integrates skills into the chat pipeline
 *
 * Implements 3-level progressive disclosure:
 * - Level 1: Metadata (name + description) injected into system prompt
 * - Level 2: Full instructions + variable resolution on slash command invocation
 * - Level 3: Bundled files (Phase 2)
 */

import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx as QueryContext } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import type { SkillAccessSubject } from "./access";
import { canReadSkill } from "./access";
import { MAX_ENABLED_SKILLS } from "./constants";
import { compareStrings } from "../lib/collections";
import type { SkillConfig } from "./validators";
import { vSkillConfig } from "./validators";
import { extractVariables, substituteVariables } from "./variables";

const WHITESPACE_RE = /\s+/;

/**
 * Skill metadata for Level 1 system prompt injection
 */
export interface SkillMetadata {
    description: string;
    name: string;
    slug: string;
}

/**
 * Resolved skill context after loading for invocation
 */
export interface SkillContext {
    config?: SkillConfig;
    instructions: string;
    resolvedVariables?: Record<string, string>;
    skillId: Id<"skills">;
}

/**
 * Tool configuration from skill
 */
export interface ToolConfig {
    additionalTools?: string[];
    disabledTools?: string[];
    searchMode?: string;
}

/**
 * Parse raw slash command arguments into key-value pairs
 * Supports: "/skill name=John age=30" → { name: "John", age: "30" }
 * Also supports: "/skill John 30" → positional args mapped to first N variables.
 */
const parseSlashCommandArgs = (rawArgs: string, variableNames: string[]): Record<string, string> => {
    const values: Record<string, string> = {};

    if (!rawArgs || !rawArgs.trim()) {
        return values;
    }

    // Try to parse as key=value pairs first
    // Anchored to a word boundary: a bare `/(\w+)=/g` rescans the whole
    // remainder from every word character that is not followed by `=`
    // (100k of them took 3.7s). A key only ever starts an argument.
    const keyValueRegex = /(?:^|\s)(\w+)=(\S+)/g;
    const keyValueMatches = [...rawArgs.matchAll(keyValueRegex)];

    if (keyValueMatches.length > 0) {
        // Key=value format
        for (const match of keyValueMatches) {
            const [, key, value] = match;

            if (key !== undefined && value !== undefined) {
                values[key] = value;
            }
        }
    } else {
        // Positional arguments - split by spaces and map to variable names
        const args = rawArgs.trim().split(WHITESPACE_RE);

        for (let index = 0; index < Math.min(args.length, variableNames.length); index += 1) {
            const name = variableNames[index];
            const value = args[index];

            if (name !== undefined && value !== undefined) {
                values[name] = value;
            }
        }
    }

    return values;
};

const findInstalledSkillBySlug = async (context: QueryContext, subject: SkillAccessSubject, skillSlug: string): Promise<Doc<"skills"> | null> => {
    const installed = await context.db
        .query("userSkills")
        .withIndex("by_user_and_enabled", (query) => query.eq("userId", subject.userId).eq("enabled", true))
        .take(MAX_ENABLED_SKILLS);
    const skills = await Promise.all(installed.map((userSkill) => context.db.skills.findFirst({ where: { _id: userSkill.skillId as Id<"skills"> } })));

    return skills.find((skill): skill is Doc<"skills"> => skill !== null && skill.slug === skillSlug && canReadSkill(skill, subject)) ?? null;
};

/**
 * Skills shared with the caller's active organization by someone else. Sharing
 * only makes them visible: each member opts IN by enabling one, which writes a
 * `userSkills` row. Used to find a shared skill by slug, so invoking one that is
 * not enabled yet says so instead of "not found".
 */
const getOrganizationSharedSkills = async (context: QueryContext, subject: SkillAccessSubject): Promise<Doc<"skills">[]> => {
    if (!subject.organizationId) {
        return [];
    }

    const { page } = await context.db.skills.findMany({
        limit: MAX_ENABLED_SKILLS,
        where: { organizationId: subject.organizationId, visibility: "organization" },
    });

    // `canReadSkill` re-checks rather than trusting the `where`, and drops the
    // caller's own skills, which reach the prompt through their own row.
    return page.filter((skill) => skill.userId !== subject.userId && canReadSkill(skill, subject));
};

/**
 * The skill `/<skillSlug>` names for this caller, or `null`. Precedence: the
 * caller's own skill, then an installed marketplace skill, then one shared with
 * their active organization. Installation alone is not access — the owner may
 * have made it private since — so `canReadSkill` re-checks every candidate.
 */
export const findSkillBySlug = async (
    context: QueryContext,
    userId: string,
    skillSlug: string,
    organizationId?: string | null,
): Promise<Doc<"skills"> | null> => {
    const subject: SkillAccessSubject = { organizationId, userId };
    const ownSkill = await context.db.skills.findFirst({ where: { slug: skillSlug, userId } });

    if (ownSkill) {
        return ownSkill;
    }

    const installed = await findInstalledSkillBySlug(context, subject, skillSlug);

    if (installed) {
        return installed;
    }

    const shared = await getOrganizationSharedSkills(context, subject);

    return shared.find((candidate) => candidate.slug === skillSlug) ?? null;
};

/**
 * Level 2 for a skill already found and access-checked: requires the caller's
 * enabled row, fills variables (`values` over each variable's default), rejects
 * a missing required one and substitutes the rest.
 *
 * Every way a skill runs — a `/<slug>` command, a task's assigned skill, a
 * group-chat participant — goes through here, so "enabled" and "required
 * variable" mean the same thing everywhere.
 */
export const prepareSkillInvocation = async (
    context: QueryContext,
    skill: Doc<"skills">,
    userId: string,
    values: Readonly<Record<string, string>> = {},
): Promise<SkillContext> => {
    const userSkill = await context.db
        .query("userSkills")
        .withIndex("by_user_and_skill", (query) => query.eq("userId", userId).eq("skillId", skill._id))
        .first();

    // Every skill needs an enabled row — organization-shared ones included, which
    // a member opts into rather than out of.
    if (!userSkill?.enabled) {
        throw new LunoraError("UNPROCESSABLE", `Skill '${skill.slug}' is not enabled. Enable it in Settings to use it.`);
    }

    const variables = skill.variables ?? [];
    const resolved: Record<string, string> = {};

    for (const variableDefinition of variables) {
        if (variableDefinition.defaultValue) {
            resolved[variableDefinition.name] = variableDefinition.defaultValue;
        }
    }

    Object.assign(resolved, values);

    const missing = variables.filter((variable) => variable.required && !Object.hasOwn(resolved, variable.name)).map((variable) => variable.name);

    if (missing.length > 0) {
        throw new LunoraError("BAD_REQUEST", `Missing required variables: ${missing.join(", ")}`);
    }

    return {
        config: skill.config,
        instructions: substituteVariables(skill.instructions, (name) => resolved[name]),
        resolvedVariables: resolved,
        skillId: skill._id,
    };
};

/**
 * Load skill for invocation (Level 2): `/<skillSlug> <rawArgs>` resolved to a
 * runnable skill, or `null` when the slug names none.
 */
export const loadSkillForInvocation = async (
    context: QueryContext,
    userId: string,
    skillSlug: string,
    rawArgs = "",
    organizationId?: string | null,
): Promise<SkillContext | null> => {
    const skill = await findSkillBySlug(context, userId, skillSlug, organizationId);

    if (!skill) {
        return null;
    }

    // Positional arguments map onto the variables in alphabetical order.
    const variableNames = extractVariables(skill.instructions).toSorted(compareStrings);

    return await prepareSkillInvocation(context, skill, userId, parseSlashCommandArgs(rawArgs, variableNames));
};

/**
 * Get enabled skills metadata for system prompt (Level 1)
 * Returns only name, slug, description for minimal token overhead (~100 tokens/skill)
 * Internal query version for use in http.ts.
 */
export const getEnabledSkillsForSystemPrompt = async (context: QueryContext, userId: string, organizationId?: string | null): Promise<SkillMetadata[]> => {
    const subject: SkillAccessSubject = { organizationId, userId };

    // Only skills the user enabled — an organization-shared skill reaches the
    // prompt once the member opts in, never merely by being shared.
    const enabledUserSkills = await context.db
        .query("userSkills")
        .withIndex("by_user_and_enabled", (query) => query.eq("userId", userId).eq("enabled", true))
        .take(MAX_ENABLED_SKILLS); // ~5K tokens

    const skills = await Promise.all(enabledUserSkills.map((userSkill) => context.db.skills.findFirst({ where: { _id: userSkill.skillId as Id<"skills"> } })));
    const seen = new Set<string>();

    // Return metadata only — and only for skills still readable by this user,
    // which drops a shared skill once the member leaves (or switches away from)
    // its organization.
    return skills
        .filter((skill): skill is Doc<"skills"> => {
            if (skill === null || seen.has(skill._id as string) || !canReadSkill(skill, subject)) {
                return false;
            }

            seen.add(skill._id as string);

            return true;
        })
        .slice(0, MAX_ENABLED_SKILLS)
        .map((skill) => {
            return {
                description: skill.description,
                name: skill.name,
                slug: skill.slug,
            };
        });
};

/**
 * Format skills metadata for system prompt injection
 * Returns XML-formatted list of available skills.
 */
export const formatSkillsForSystemPrompt = (skills: SkillMetadata[]): string => {
    if (skills.length === 0) {
        return "";
    }

    const skillsList = skills.map((skill) => `- /${skill.slug}: ${skill.description}`).join("\n");

    return `
AVAILABLE SKILLS:
${skillsList}

When a user's request matches a skill, you can reference it in your response. Skills are invoked via slash commands (e.g., /skill-name).`;
};

/**
 * Merge skill config into base tools configuration
 * Applies searchMode override, adds additionalTools, removes disabledTools.
 */
export const mergeSkillConfigIntoTools = (skillConfig: ToolConfig | undefined, baseConfig: { searchMode: string }): { searchMode: string } => {
    if (!skillConfig) {
        return baseConfig;
    }

    return {
        searchMode: skillConfig.searchMode || baseConfig.searchMode,
        // Note: additionalTools and disabledTools will be handled by toolBuilder.ts
        // This function just returns the effective searchMode
    };
};

export const loadSkillForInvocationQuery = internalQuery
    .input({
        /** The caller's ACTIVE organization — pass `ctx.user.activeOrganization?.id`, never a client value. */
        organizationId: v.optional(v.string()),
        rawArgs: v.string(),
        skillSlug: v.string(),
        userId: v.string(),
    })
    .output(
        v.union(
            v.null(),
            v.object({
                config: v.optional(vSkillConfig),
                instructions: v.string(),
                resolvedVariables: v.optional(v.any()),
                skillId: v.id("skills"),
            }),
        ),
    )
    .query(
        async ({ args: { organizationId, rawArgs, skillSlug, userId }, ctx }) => await loadSkillForInvocation(ctx, userId, skillSlug, rawArgs, organizationId),
    );

export const getEnabledSkillsForSystemPromptQuery = internalQuery
    .input({
        /** The caller's ACTIVE organization — pass `ctx.user.activeOrganization?.id`, never a client value. */
        organizationId: v.optional(v.string()),
        userId: v.string(),
    })
    .output(
        v.array(
            v.object({
                description: v.string(),
                name: v.string(),
                slug: v.string(),
            }),
        ),
    )
    .query(async ({ args: { organizationId, userId }, ctx }) => await getEnabledSkillsForSystemPrompt(ctx, userId, organizationId));

/**
 * The unsaved draft an Agent Builder test drive attached to this temporary
 * thread (`skills/builder.ts`), shaped as an invocation. Only the thread's own
 * user gets it, and only while the temporary row is live — the draft is deleted
 * with the row, and a thread converted to permanent loses it.
 */
const loadTestDriveDraft = async (
    context: QueryContext,
    threadId: string,
    userId: string,
): Promise<{ config?: SkillContext["config"]; instructions: string; slug: string } | null> => {
    const row = await context.db
        .query("temporaryThreads")
        .withIndex("by_thread", (query) => query.eq("threadId", threadId as Id<"threads">))
        .first();

    if (!row?.skillDraft || row.userId !== userId || row.expiresAt <= Date.now()) {
        return null;
    }

    return { config: row.skillDraft.config, instructions: row.skillDraft.instructions, slug: "draft" };
};

/**
 * Everything a chat run needs from skills, in one round trip: the Level 1
 * metadata for the system prompt and — when the message starts with `/<slug>` —
 * the Level 2 invocation.
 *
 * A slug that names no skill resolves to `invocation: null` and the message runs
 * as ordinary text (it may be a path, or a slash word the user meant literally).
 * A skill that exists but cannot run — disabled, missing a required variable —
 * comes back as `error` so the run can say why instead of silently ignoring it.
 */
export const resolveSkillsForRun = internalQuery
    .input({
        /** The caller's ACTIVE organization — resolved server-side, never a client value. */
        organizationId: v.optional(v.string()),
        rawArgs: v.optional(v.string()),
        skillSlug: v.optional(v.string()),
        /** The run's thread — an Agent Builder test-drive thread carries an unsaved draft to run against. */
        threadId: v.optional(v.string()),
        userId: v.string(),
    })
    .output(
        v.object({
            enabledSkills: v.array(v.object({ description: v.string(), name: v.string(), slug: v.string() })),
            error: v.optional(v.string()),
            invocation: v.union(
                v.null(),
                v.object({
                    config: v.optional(vSkillConfig),
                    instructions: v.string(),
                    /** Absent for a test-drive draft, which has no row yet. */
                    skillId: v.optional(v.id("skills")),
                    slug: v.string(),
                }),
            ),
        }),
    )
    .query(async ({ args: { organizationId, rawArgs, skillSlug, threadId, userId }, ctx }) => {
        const enabledSkills = await getEnabledSkillsForSystemPrompt(ctx, userId, organizationId);

        if (!skillSlug) {
            return { enabledSkills, invocation: threadId ? await loadTestDriveDraft(ctx, threadId, userId) : null };
        }

        try {
            const loaded = await loadSkillForInvocation(ctx, userId, skillSlug, rawArgs ?? "", organizationId);

            if (loaded) {
                return { enabledSkills, invocation: { config: loaded.config, instructions: loaded.instructions, skillId: loaded.skillId, slug: skillSlug } };
            }

            // An explicit `/<slug>` wins; a slug naming no skill falls back to the draft.
            return { enabledSkills, invocation: threadId ? await loadTestDriveDraft(ctx, threadId, userId) : null };
        } catch (error) {
            // Only our own validation errors are surfaced; anything else is a bug and rethrown.
            if (error instanceof LunoraError && (error.code === "UNPROCESSABLE" || error.code === "BAD_REQUEST")) {
                return { enabledSkills, error: error.message, invocation: null };
            }

            throw error;
        }
    });
