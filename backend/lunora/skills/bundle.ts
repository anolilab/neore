/**
 * Team bundles: export a chosen set of the caller's skills, schedules /
 * webhooks and group chats as ONE Markdown file, and import such a file
 * (`bundle-format.ts` is the format, `bundle-plan.ts` the dry run and the
 * all-or-nothing import).
 *
 * - Export reads only what the caller OWNS (an id of anyone else's is
 *   `NOT_FOUND`), projects each row to the whitelisted fields in
 *   `loadBundleSources`, and builds the file from those. The participants of an
 *   exported group chat are added through `getSkill`, which decides who may
 *   read a skill.
 * - Preview and import both parse the file on the SERVER and plan it against
 *   the caller's current state; the plan is never taken from the client. An
 *   import creates through `createSkill`, `createGroupChat` and `createTrigger`
 *   themselves, so every rule of the editor applies, and triggers are created
 *   disabled by `createTrigger` itself.
 * - The three creates are separate mutations, so "all or nothing" is best
 *   effort: a failure removes what was created (`runBundleImport`), and a crash
 *   in the middle can leave disabled items behind.
 */
import { MODEL_LOOKUP } from "@neore/ai/models";
import { LunoraError, v } from "lunorash/server";

import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { authAction, authQuery, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import type { BundleItem, SkillSource } from "./bundle-format";
import { BUNDLE_LIMITS, buildBundleMarkdown, groupItemOf, parseBundleMarkdown, skillItemOf, triggerItemOf } from "./bundle-format";
import type { PlanEntry, PlanEnv } from "./bundle-plan";
import { assertSelectionImportable, BundleImportError, planBundle, runBundleImport, skillLimitFor } from "./bundle-plan";
import { isSelectableTextModel } from "./builder-logic";
import { getToolRegistry } from "./jit-tool-loader";
import { toSkillSlug } from "./markdown";
import { pickFreeSlug } from "./slug";

/** The newest chats scanned for group chats: `threads` has no index on `groupChat`. */
const GROUP_SCAN_LIMIT = 300;

const isRunnableModel = (model: string): boolean => {
    const definition = MODEL_LOOKUP.get(model);

    return definition !== undefined && isSelectableTextModel(definition);
};

const knownToolNames = (): Set<string> => new Set(getToolRegistry().map((tool) => tool.name));

const vKind = v.union(v.literal("skill"), v.literal("trigger"), v.literal("group"));

// ─── Choosing what to export ────────────────────────────────────────────────

/** The caller's own skills, schedules / webhooks and group chats, for the export dialog. */
export const listBundleCandidates = authQuery
    .input({})
    .output(
        v.object({
            groupChats: v.array(
                v.object({
                    exportable: v.boolean(),
                    id: v.id("threads"),
                    mode: v.string(),
                    /** The skills it brings along into the file. */
                    participantSkillIds: v.array(v.string()),
                    reason: v.optional(v.string()),
                    title: v.string(),
                }),
            ),
            limits: v.object({ groupChats: v.number(), skills: v.number(), triggers: v.number() }),
            skills: v.array(v.object({ description: v.string(), id: v.id("skills"), name: v.string(), slug: v.string() })),
            triggers: v.array(
                v.object({
                    exportable: v.boolean(),
                    id: v.id("triggers"),
                    name: v.string(),
                    reason: v.optional(v.string()),
                    schedule: v.optional(v.string()),
                    type: v.union(v.literal("schedule"), v.literal("webhook")),
                }),
            ),
        }),
    )
    .query(async ({ ctx }) => {
        const { userId } = ctx.user;
        const [{ page: skills }, triggers, threads] = await Promise.all([
            ctx.db.skills.findMany({ where: { userId } }),
            ctx.db
                .query("triggers")
                .withIndex("by_userId_organizationId", (q) => q.eq("userId", userId))
                .collect(),
            ctx.db
                .query("threads")
                .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId))
                .order("desc")
                .take(GROUP_SCAN_LIMIT),
        ]);

        return {
            groupChats: threads.flatMap((thread) => {
                const group = thread.groupChat;

                if (!group || group.participants.length === 0 || thread.deleted === true) {
                    return [];
                }

                const result = groupItemOf({ groupChat: group, model: thread.model, title: thread.title }, (id) => id);

                return [
                    {
                        exportable: result.ok,
                        id: thread._id,
                        mode: group.mode,
                        participantSkillIds: group.participants.map((participant) => participant.skillId),
                        ...(!result.ok && { reason: result.reason }),
                        title: thread.title?.trim() || "Group chat",
                    },
                ];
            }),
            limits: { groupChats: BUNDLE_LIMITS.groupChats, skills: BUNDLE_LIMITS.skills, triggers: BUNDLE_LIMITS.triggers },
            skills: skills.map((skill) => {
                return { description: skill.description, id: skill._id, name: skill.name, slug: skill.slug };
            }),
            triggers: triggers.flatMap((trigger) => {
                if (trigger.type !== "schedule" && trigger.type !== "webhook") {
                    return [];
                }

                const result = triggerItemOf(trigger);

                return [
                    {
                        exportable: result.ok,
                        id: trigger._id,
                        name: trigger.name,
                        ...(!result.ok && { reason: result.reason }),
                        ...(trigger.cronExpression && { schedule: trigger.cronExpression }),
                        type: trigger.type,
                    },
                ];
            }),
        };
    });

/** The whitelisted skill fields. The source, owner, organization, voice and variable defaults are not among them. */
const skillFields = (skill: {
    category?: string;
    config?: {
        additionalTools?: string[];
        disabledTools?: string[];
        preferredModel?: string;
        reasoningEffort?: number;
        searchMode?: string;
    };
    description: string;
    icon?: string;
    instructions: string;
    name: string;
    slug: string;
    tags?: string[];
    variables?: { description?: string; name: string; required?: boolean }[];
    version?: string;
}) => {
    return {
        ...(skill.category !== undefined && { category: skill.category }),
        ...(skill.config && {
            config: {
                ...(skill.config.additionalTools !== undefined && { additionalTools: skill.config.additionalTools }),
                ...(skill.config.disabledTools !== undefined && { disabledTools: skill.config.disabledTools }),
                ...(skill.config.preferredModel !== undefined && { preferredModel: skill.config.preferredModel }),
                ...(skill.config.reasoningEffort !== undefined && { reasoningEffort: skill.config.reasoningEffort }),
                ...(skill.config.searchMode !== undefined && { searchMode: skill.config.searchMode }),
            },
        }),
        description: skill.description,
        ...(skill.icon !== undefined && { icon: skill.icon }),
        instructions: skill.instructions,
        name: skill.name,
        slug: skill.slug,
        ...(skill.tags !== undefined && { tags: skill.tags }),
        ...(skill.variables && {
            variables: skill.variables.map((variable) => {
                return {
                    ...(variable.description !== undefined && { description: variable.description }),
                    name: variable.name,
                    ...(variable.required !== undefined && { required: variable.required }),
                };
            }),
        }),
        ...(skill.version !== undefined && { version: skill.version }),
    };
};

/**
 * The rows an export needs, for the ids the caller picked — and ONLY if every
 * one is the caller's own. Each row is projected to the whitelisted fields
 * here, and the declared output rejects anything more: the secrets on a
 * trigger row (`webhookSecret`), its bot, an organization id never leave this
 * query.
 */
export const loadBundleSources = internalQuery
    .input({
        groupChatIds: v.array(v.id("threads")),
        skillIds: v.array(v.id("skills")),
        triggerIds: v.array(v.id("triggers")),
        userId: v.string(),
    })
    .output(
        v.object({
            groupChats: v.array(
                v.object({
                    groupChat: v.object({
                        debateRounds: v.optional(v.number()),
                        mode: v.union(v.literal("supervisor"), v.literal("round-robin"), v.literal("mention-only"), v.literal("parallel"), v.literal("debate")),
                        participants: v.array(v.object({ skillId: v.string() })),
                        synthesizerSkillId: v.optional(v.string()),
                    }),
                    id: v.string(),
                    model: v.optional(v.string()),
                    title: v.optional(v.string()),
                }),
            ),
            skills: v.array(
                v.object({
                    category: v.optional(v.string()),
                    config: v.optional(
                        v.object({
                            additionalTools: v.optional(v.array(v.string())),
                            disabledTools: v.optional(v.array(v.string())),
                            preferredModel: v.optional(v.string()),
                            reasoningEffort: v.optional(v.number()),
                            searchMode: v.optional(v.string()),
                        }),
                    ),
                    description: v.string(),
                    icon: v.optional(v.string()),
                    id: v.string(),
                    instructions: v.string(),
                    name: v.string(),
                    slug: v.string(),
                    tags: v.optional(v.array(v.string())),
                    variables: v.optional(v.array(v.object({ description: v.optional(v.string()), name: v.string(), required: v.optional(v.boolean()) }))),
                    version: v.optional(v.string()),
                }),
            ),
            triggers: v.array(
                v.object({
                    cronExpression: v.optional(v.string()),
                    description: v.optional(v.string()),
                    filters: v.optional(
                        v.array(
                            v.object({
                                op: v.union(
                                    v.literal("equals"),
                                    v.literal("not_equals"),
                                    v.literal("contains"),
                                    v.literal("starts_with"),
                                    v.literal("exists"),
                                    v.literal("not_exists"),
                                ),
                                path: v.string(),
                                value: v.optional(v.string()),
                            }),
                        ),
                    ),
                    id: v.string(),
                    inputTemplate: v.optional(v.string()),
                    model: v.string(),
                    name: v.string(),
                    searchMode: v.optional(v.string()),
                    systemPrompt: v.optional(v.string()),
                    timezone: v.optional(v.string()),
                    type: v.string(),
                    webhookSignatureScheme: v.optional(v.string()),
                }),
            ),
        }),
    )
    .query(async ({ args, ctx }) => {
        const notFound = (): never => {
            throw new LunoraError("NOT_FOUND", "One of the items to export was not found");
        };
        const skills = await Promise.all(args.skillIds.map(async (skillId) => await ctx.db.skills.findFirst({ where: { _id: skillId } })));
        const triggers = await Promise.all(args.triggerIds.map(async (triggerId) => await ctx.db.get(triggerId)));
        const threads = await Promise.all(args.groupChatIds.map(async (threadId) => await ctx.db.get(threadId)));

        return {
            groupChats: threads.map((thread) => {
                if (!thread || thread.userId !== args.userId || !thread.groupChat || thread.deleted === true) {
                    return notFound();
                }

                const { debateRounds, mode, participants, synthesizerSkillId } = thread.groupChat;

                return {
                    groupChat: {
                        ...(debateRounds !== undefined && { debateRounds }),
                        mode,
                        participants: participants.map((participant) => {
                            return { skillId: participant.skillId };
                        }),
                        ...(synthesizerSkillId !== undefined && { synthesizerSkillId }),
                    },
                    id: thread._id,
                    ...(thread.model !== undefined && { model: thread.model }),
                    ...(thread.title !== undefined && { title: thread.title }),
                };
            }),
            skills: skills.map((skill) => {
                if (!skill || skill.userId !== args.userId) {
                    return notFound();
                }

                return { ...skillFields(skill), id: skill._id };
            }),
            triggers: triggers.map((trigger) => {
                if (!trigger || trigger.userId !== args.userId) {
                    return notFound();
                }

                return {
                    ...(trigger.cronExpression !== undefined && { cronExpression: trigger.cronExpression }),
                    ...(trigger.description !== undefined && { description: trigger.description }),
                    ...(trigger.filters && {
                        filters: trigger.filters.map((filter) => {
                            return { op: filter.op, path: filter.path, ...(filter.value !== undefined && { value: filter.value }) };
                        }),
                    }),
                    id: trigger._id,
                    ...(trigger.inputTemplate !== undefined && { inputTemplate: trigger.inputTemplate }),
                    model: trigger.model,
                    name: trigger.name,
                    ...(trigger.searchMode !== undefined && { searchMode: trigger.searchMode }),
                    ...(trigger.systemPrompt !== undefined && { systemPrompt: trigger.systemPrompt }),
                    ...(trigger.timezone !== undefined && { timezone: trigger.timezone }),
                    type: trigger.type,
                    ...(trigger.webhookSignatureScheme !== undefined && { webhookSignatureScheme: trigger.webhookSignatureScheme }),
                };
            }),
        };
    });

// ─── Export ─────────────────────────────────────────────────────────────────

const assertWithin = (count: number, limit: number, what: string): void => {
    if (count > limit) {
        throw new LunoraError("BAD_REQUEST", `A bundle holds at most ${String(limit)} ${what}`);
    }
};

/**
 * The picked items as one Markdown file. Secrets never reach it: only
 * whitelisted fields are read (`loadBundleSources`, then the builders in
 * `bundle-format.ts`). A group chat brings its participants along, read through
 * `getSkill`'s access check and referenced by slug.
 */
export const exportBundle = authAction
    .use(rateLimit("skills/bundle"))
    .input({
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        groupChatIds: v.array(v.id("threads")),
        name: v.string().max(MAX_LENGTH.short),
        skillIds: v.array(v.id("skills")),
        triggerIds: v.array(v.id("triggers")),
    })
    .output(v.object({ filename: v.string(), itemCount: v.number(), markdown: v.string() }))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const skillIds = [...new Set(args.skillIds)];
        const triggerIds = [...new Set(args.triggerIds)];
        const groupChatIds = [...new Set(args.groupChatIds)];

        assertWithin(skillIds.length, BUNDLE_LIMITS.skills, "skills");
        assertWithin(triggerIds.length, BUNDLE_LIMITS.triggers, "triggers");
        assertWithin(groupChatIds.length, BUNDLE_LIMITS.groupChats, "group chats");

        if (skillIds.length + triggerIds.length + groupChatIds.length === 0) {
            throw new LunoraError("BAD_REQUEST", "Pick at least one item to export");
        }

        const sources = await ctx.runQuery(internal.skills.bundle.loadBundleSources, { groupChatIds, skillIds, triggerIds, userId });
        const isKnownTool = (name: string): boolean => knownTools.has(name);
        const knownTools = knownToolNames();

        // The skills the file carries: the picked ones, then the participants of the group chats.
        const skillSources = new Map<string, SkillSource>(sources.skills.map((skill) => [skill.id, skill]));

        for (const group of sources.groupChats) {
            const wanted = [
                ...group.groupChat.participants.map((participant) => participant.skillId),
                ...(group.groupChat.synthesizerSkillId ? [group.groupChat.synthesizerSkillId] : []),
            ];

            for (const skillId of wanted) {
                if (skillSources.has(skillId)) {
                    continue;
                }

                // `getSkill` is the access check: it returns null or throws FORBIDDEN for a skill the caller may not read.
                const skill = await ctx.runQuery(api.skills.functions.getSkill, { skillId: skillId as Id<"skills"> }).catch(() => null);

                if (!skill) {
                    throw new LunoraError(
                        "BAD_REQUEST",
                        `A participant of "${group.title ?? "a group chat"}" is not available to you, so it cannot be exported.`,
                    );
                }

                skillSources.set(skillId, skill);
            }
        }

        assertWithin(skillSources.size, BUNDLE_LIMITS.skills, "skills (the participants of the group chats count)");

        // A slug is the key group chats use for their participants, so it is unique in the file.
        const takenSlugs = new Set<string>();
        const slugById = new Map<string, string>();

        for (const [skillId, skill] of skillSources) {
            const slug = pickFreeSlug(skill.slug, takenSlugs);

            takenSlugs.add(slug);
            slugById.set(skillId, slug);
        }

        const items: BundleItem[] = [...skillSources].map(([skillId, skill]) => skillItemOf(skill, { isKnownTool, slug: slugById.get(skillId) }));

        for (const trigger of sources.triggers) {
            const result = triggerItemOf(trigger);

            if (!result.ok) {
                throw new LunoraError("BAD_REQUEST", `"${trigger.name}" cannot be exported. ${result.reason}`);
            }

            items.push(result.item);
        }

        for (const group of sources.groupChats) {
            const result = groupItemOf(group, (skillId) => slugById.get(skillId));

            if (!result.ok) {
                throw new LunoraError("BAD_REQUEST", `"${group.title ?? "A group chat"}" cannot be exported. ${result.reason}`);
            }

            items.push(result.item);
        }

        const name = args.name.trim() || "Team bundle";
        const markdown = buildBundleMarkdown({ description: args.description ?? "", items, name });
        const check = parseBundleMarkdown(markdown);

        if (!check.ok) {
            throw new LunoraError("BAD_REQUEST", check.errors.join("; "));
        }

        const unreadable = check.bundle.entries.find((entry) => entry.problems.length > 0);

        if (unreadable) {
            throw new LunoraError("BAD_REQUEST", `"${unreadable.label}" cannot be exported: ${unreadable.problems.join(" ")}`);
        }

        ctx.log.event("skills.bundle_export", { groupChats: sources.groupChats.length, skills: skillSources.size, triggers: sources.triggers.length });

        return { filename: `${toSkillSlug(name) || "bundle"}.bundle.md`, itemCount: items.length, markdown };
    });

// ─── Import ─────────────────────────────────────────────────────────────────

/** What the dry run needs to know about the caller's skills. */
export const loadImportContext = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ skillCount: v.number(), slugs: v.array(v.string()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const { page: skills } = await ctx.db.skills.findMany({ where: { userId } });

        return { skillCount: skills.length, slugs: skills.map((skill) => skill.slug) };
    });

const planFor = async (
    ctx: {
        runQuery: (reference: typeof internal.skills.bundle.loadImportContext, args: { userId: string }) => Promise<{ skillCount: number; slugs: string[] }>;
        user: { isAdmin?: boolean; plan?: string | null; userId: string };
    },
    markdown: string,
    selected: ReadonlySet<string> | undefined,
): Promise<{ bundle: { description: string; name: string }; entries: PlanEntry[]; env: PlanEnv }> => {
    const parsed = parseBundleMarkdown(markdown);

    if (!parsed.ok) {
        throw new LunoraError("BAD_REQUEST", parsed.errors.join("; "));
    }

    const known = await ctx.runQuery(internal.skills.bundle.loadImportContext, { userId: ctx.user.userId });
    const knownTools = knownToolNames();
    const env: PlanEnv = {
        existingSkillCount: known.skillCount,
        existingSlugs: new Set(known.slugs),
        isKnownTool: (name) => knownTools.has(name),
        isModelRunnable: isRunnableModel,
        now: Date.now(),
        skillLimit: skillLimitFor(ctx.user),
    };

    return { bundle: parsed.bundle, entries: planBundle(parsed.bundle, selected, env), env };
};

/**
 * The review screen's content: every item of an uploaded bundle and what
 * importing it would do. A full dry run — nothing is created here.
 */
export const previewBundle = authAction
    .use(rateLimit("skills/bundle"))
    .input({ markdown: v.string().max(MAX_LENGTH.document) })
    .output(
        v.object({
            description: v.string(),
            entries: v.array(
                v.object({
                    group: v.optional(
                        v.object({
                            debateRounds: v.optional(v.number()),
                            mode: v.string(),
                            model: v.string(),
                            participants: v.array(v.string()),
                            synthesizer: v.optional(v.string()),
                        }),
                    ),
                    key: v.string(),
                    kind: vKind,
                    problems: v.array(v.string()),
                    requires: v.array(v.string()),
                    skill: v.optional(
                        v.object({
                            description: v.string(),
                            disabledTools: v.array(v.string()),
                            droppedTools: v.array(v.string()),
                            model: v.optional(v.string()),
                            name: v.string(),
                            slug: v.string(),
                            tools: v.array(v.string()),
                        }),
                    ),
                    title: v.string(),
                    trigger: v.optional(
                        v.object({
                            description: v.optional(v.string()),
                            filters: v.array(v.string()),
                            model: v.string(),
                            nextRunAt: v.optional(v.number()),
                            schedule: v.optional(v.string()),
                            systemPrompt: v.optional(v.string()),
                            task: v.optional(v.string()),
                            timezone: v.optional(v.string()),
                            type: v.union(v.literal("schedule"), v.literal("webhook")),
                        }),
                    ),
                    warnings: v.array(v.string()),
                }),
            ),
            name: v.string(),
            /** Skills a free account may still add; `null` when it has no limit. */
            skillSlotsLeft: v.union(v.number(), v.null()),
        }),
    )
    .action(async ({ args, ctx }) => {
        const { bundle, entries, env } = await planFor(ctx, args.markdown, undefined);

        ctx.log.event("skills.bundle_preview", { entries: entries.length, ready: entries.filter((entry) => entry.problems.length === 0).length });

        return {
            description: bundle.description,
            entries: entries.map((entry) => {
                return {
                    key: entry.key,
                    kind: entry.kind,
                    problems: entry.problems,
                    requires: entry.requires,
                    title: entry.title,
                    warnings: entry.warnings,
                    ...entry.view,
                };
            }),
            name: bundle.name,
            skillSlotsLeft: env.skillLimit === undefined ? null : Math.max(0, env.skillLimit - env.existingSkillCount),
        };
    });

/**
 * Imports the picked items of a bundle. The file is parsed and planned again
 * here; a blocked pick refuses the whole import before anything is created,
 * and a failure while creating removes what was created. Triggers come out
 * disabled (`createTrigger`), group chats start nothing, and a new webhook's
 * signing secret is returned ONCE, in this result — only its encrypted form is
 * stored.
 */
export const importBundle = authAction
    .use(rateLimit("skills/bundle"))
    .input({
        markdown: v.string().max(MAX_LENGTH.document),
        selected: v.array(v.string().max(MAX_LENGTH.short)),
    })
    .output(
        v.object({
            items: v.array(
                v.object({
                    id: v.string(),
                    key: v.string(),
                    kind: vKind,
                    title: v.string(),
                    webhookSecret: v.optional(v.string()),
                }),
            ),
            warnings: v.array(v.string()),
        }),
    )
    .action(async ({ args, ctx }) => {
        const selected = new Set(args.selected);

        assertWithin(selected.size, BUNDLE_LIMITS.skills + BUNDLE_LIMITS.triggers + BUNDLE_LIMITS.groupChats, "items");

        const { entries } = await planFor(ctx, args.markdown, selected);

        assertSelectionImportable(entries, selected);

        try {
            const items = await runBundleImport(entries, selected, {
                createGroupChat: async (group) => {
                    const { threadId } = await ctx.runMutation(api.chat.group.functions.createGroupChat, {
                        ...(group.debateRounds !== undefined && { debateRounds: group.debateRounds }),
                        mode: group.mode,
                        model: group.model,
                        skillIds: group.skillIds,
                        ...(group.synthesizerSkillId !== undefined && { synthesizerSkillId: group.synthesizerSkillId }),
                        title: group.title,
                    });

                    return threadId;
                },
                createSkill: async (skill) =>
                    await ctx.runMutation(api.skills.functions.createSkill, {
                        ...skill,
                        source: { filename: "bundle.md", type: "upload", uploadedAt: Date.now() },
                        visibility: "private",
                    }),
                createTrigger: async (trigger) => await ctx.runMutation(api.triggers.functions.createTrigger, trigger),
                deleteGroupChat: async (threadId) => await ctx.runMutation(api.chat.functions.deleteThread, { threadId: threadId as Id<"threads"> }),
                deleteSkill: async (skillId) => await ctx.runMutation(api.skills.functions.deleteSkill, { skillId: skillId as Id<"skills"> }),
                deleteTrigger: async (triggerId) => await ctx.runMutation(api.triggers.functions.deleteTrigger, { triggerId: triggerId as Id<"triggers"> }),
            });

            // Counts only: the result carries a webhook secret, which must not reach a log.
            ctx.log.event("skills.bundle_import", {
                groupChats: items.filter((item) => item.kind === "group").length,
                skills: items.filter((item) => item.kind === "skill").length,
                triggers: items.filter((item) => item.kind === "trigger").length,
            });

            return {
                items,
                warnings: entries.filter((entry) => selected.has(entry.key)).flatMap((entry) => entry.warnings.map((warning) => `${entry.title}: ${warning}`)),
            };
        } catch (error) {
            throw error instanceof BundleImportError ? new LunoraError("BAD_REQUEST", error.message) : error;
        }
    });
