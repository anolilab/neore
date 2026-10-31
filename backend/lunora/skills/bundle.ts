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
 *   import creates skills through `createSkill` and triggers through
 *   `createTrigger` themselves, so every rule of the editor applies (and
 *   `createTrigger` makes triggers disabled). Group chats go through the
 *   internal `createImportedGroupChat`, which applies the same participant and
 *   option checks but accepts participants that are switched off.
 * - Imported skills are created SWITCHED OFF: an enabled skill's name and
 *   description go into the system prompt of every chat, so a file from someone
 *   else must not reach them until the user turns the skill on. Triggers are
 *   created disabled, and a group chat starts nothing.
 * - The three creates are separate mutations, so "all or nothing" is best
 *   effort: a failure removes what was created (`removeImportedItem`, a hard
 *   delete no rate limit can refuse), and a crash in the middle can leave
 *   switched-off items behind.
 * - One `importId` imports once (`lib/claim-once.ts`): a client that retries after
 *   a timeout is told the import already happened instead of importing twice.
 */
import { MODEL_LOOKUP } from "@neore/ai/models";
import { LunoraError, v } from "lunorash/server";

import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { authAction, authQuery, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import type { BundleItem, SkillSource } from "./bundle-format";
import { BUNDLE_LIMITS, buildBundleMarkdown, groupItemOf, parseBundleMarkdown, skillItemOf, triggerItemOf } from "./bundle-format";
import type { PlanEntry, PlanEnv } from "./bundle-plan";
import { assertSelectionImportable, BundleImportError, mayRetryImport, planBundle, runBundleImport, skillLimitFor } from "./bundle-plan";
import { isSelectableTextModel } from "./builder-logic";
import { getToolRegistry } from "./jit-tool-loader";
import { deleteTriggerRows } from "../triggers/functions";
import { deleteSkillRows } from "./functions";
import { canReadSkill } from "./access";
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

/**
 * The skills the groups name that the caller may read: their own, plus the others `exportBundle` would get through
 * `getSkill` (an organization-shared one). A deleted or no-longer-shared participant is not among them.
 */
const readableSkillIds = async (
    ctx: {
        db: { skills: { findFirst: (query: { where: { _id: Id<"skills"> } }) => Promise<Doc<"skills"> | null> } };
        user: { activeOrganization?: { id: string } | null; userId: string };
    },
    groups: ReadonlyArray<{ groupChat?: { participants: ReadonlyArray<{ skillId: string }>; synthesizerSkillId?: string } }>,
    owned: ReadonlySet<string>,
): Promise<Set<string>> => {
    const readable = new Set(owned);
    const others = new Set(
        groups.flatMap((thread) => [
            ...(thread.groupChat?.participants.map((participant) => participant.skillId) ?? []),
            ...(thread.groupChat?.synthesizerSkillId ? [thread.groupChat.synthesizerSkillId] : []),
        ]),
    );
    const subject = { organizationId: ctx.user.activeOrganization?.id, userId: ctx.user.userId };

    for (const skillId of others) {
        if (owned.has(skillId)) {
            continue;
        }

        const skill = await ctx.db.skills.findFirst({ where: { _id: skillId as Id<"skills"> } });

        if (skill && canReadSkill(skill, subject)) {
            readable.add(skillId);
        }
    }

    return readable;
};

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

        const groups = threads.flatMap((thread) => (thread.groupChat && thread.groupChat.participants.length > 0 && thread.deleted !== true ? [thread] : []));
        const readable = await readableSkillIds(ctx, groups, new Set(skills.map((skill) => skill._id as string)));

        return {
            groupChats: groups.flatMap((thread) => {
                const group = thread.groupChat!;
                const result = groupItemOf({ groupChat: group, model: thread.model, title: thread.title }, (id) => (readable.has(id) ? id : undefined));

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
        // Bounded before anything reads them: the distinct-count checks below run only after a dedupe.
        groupChatIds: v.array(v.id("threads")).max(BUNDLE_LIMITS.groupChats),
        name: v.string().max(MAX_LENGTH.short),
        skillIds: v.array(v.id("skills")).max(BUNDLE_LIMITS.skills),
        triggerIds: v.array(v.id("triggers")).max(BUNDLE_LIMITS.triggers),
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
        const knownTools = knownToolNames();
        const isKnownTool = (name: string): boolean => knownTools.has(name);

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

/**
 * Hard-deletes one item an import created, for the rollback of a failed import. Owner only, and no
 * rate limit: the deletes of `deleteSkill` / `deleteTrigger` / `deleteThread` are limited per minute
 * and soft-fail an import that is already half done. An item that is already gone is a success.
 */
export const removeImportedItem = internalMutation
    .input({ id: v.string().max(MAX_LENGTH.id), kind: vKind, userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args: { id, kind, userId }, ctx }) => {
        const forbidden = (): never => {
            throw new LunoraError("FORBIDDEN", "Not authorized to remove this item");
        };

        if (kind === "skill") {
            const skill = await ctx.db.skills.findFirst({ where: { _id: id as Id<"skills"> } });

            if (skill && skill.userId !== userId) {
                return forbidden();
            }

            if (skill) {
                // The history rows are this import's own, written by `createSkill`; `deleteSkill` keeps them.
                const history = await ctx.db
                    .query("skillHistory")
                    .withIndex("by_skill_version", (q) => q.eq("skillId", skill._id))
                    .collect();

                await Promise.all(history.map(async (row) => await ctx.db.delete(row._id)));
                await deleteSkillRows(ctx, skill._id, userId);
            }
        } else if (kind === "trigger") {
            const trigger = await ctx.db.get(id as Id<"triggers">);

            if (trigger && trigger.userId !== userId) {
                return forbidden();
            }

            if (trigger) {
                await deleteTriggerRows(ctx, trigger._id);
            }
        } else {
            const thread = await ctx.db.get(id as Id<"threads">);

            if (thread && (thread.userId !== userId || !thread.groupChat)) {
                return forbidden();
            }

            if (thread) {
                await ctx.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, { threadId: thread._id });
            }
        }

        return null;
    });

/** `lib/claim-once.ts` scope of an import's `importId`. */
const IMPORT_CLAIM_SCOPE = "bundle-import";

/** How long a retry of the same `importId` is recognised. */
const IMPORT_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

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
                            instructions: v.string(),
                            model: v.optional(v.string()),
                            name: v.string(),
                            reasoningEffort: v.optional(v.number()),
                            searchMode: v.optional(v.string()),
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
 * and a failure while creating removes what was created. Skills come out
 * switched off and triggers disabled, group chats start nothing, and a new webhook's
 * signing secret is returned ONCE, in this result — only its encrypted form is
 * stored.
 */
export const importBundle = authAction
    .use(rateLimit("skills/bundle"))
    .input({
        /** Minted by the client per attempt (and kept across a retry of it): an id that was imported already is refused. */
        importId: v.string().max(MAX_LENGTH.id),
        markdown: v.string().max(MAX_LENGTH.document),
        selected: v.array(v.string().max(MAX_LENGTH.short)).max(BUNDLE_LIMITS.skills + BUNDLE_LIMITS.triggers + BUNDLE_LIMITS.groupChats),
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

        // Taken once the pick is known to be importable, so a refused pick leaves the id free.
        const claimId = `${ctx.user.userId}:${args.importId}`;
        const claimed = await ctx.runMutation(internal.lib.claim_once.claimKey, {
            key: claimId,
            scope: IMPORT_CLAIM_SCOPE,
            ttlMs: IMPORT_CLAIM_TTL_MS,
            userId: ctx.user.userId,
        });

        if (!claimed) {
            throw new LunoraError("CONFLICT", "This bundle was already imported. Check your skills, schedules and group chats before importing it again.");
        }

        const { userId } = ctx.user;
        const remove = async (kind: "group" | "skill" | "trigger", id: string): Promise<null> =>
            await ctx.runMutation(internal.skills.bundle.removeImportedItem, { id, kind, userId });

        try {
            const items = await runBundleImport(entries, selected, {
                createGroupChat: async (group) => {
                    const { threadId } = await ctx.runMutation(internal.chat.group.functions.createImportedGroupChat, {
                        ...(group.debateRounds !== undefined && { debateRounds: group.debateRounds }),
                        mode: group.mode,
                        model: group.model,
                        ...(ctx.user.activeOrganization?.id && { organizationId: ctx.user.activeOrganization.id }),
                        skillIds: group.skillIds,
                        ...(group.synthesizerSkillId !== undefined && { synthesizerSkillId: group.synthesizerSkillId }),
                        title: group.title,
                        userId,
                    });

                    return threadId;
                },
                createSkill: async (skill) =>
                    await ctx.runMutation(api.skills.functions.createSkill, {
                        ...skill,
                        enabled: false,
                        source: { filename: "bundle.md", type: "upload", uploadedAt: Date.now() },
                        visibility: "private",
                    }),
                createTrigger: async (trigger) => await ctx.runMutation(api.triggers.functions.createTrigger, trigger),
                deleteGroupChat: async (threadId) => await remove("group", threadId),
                deleteSkill: async (skillId) => await remove("skill", skillId),
                deleteTrigger: async (triggerId) => await remove("trigger", triggerId),
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
            // A clean rollback makes a retry of the same id a new attempt; leftovers keep the id taken (`mayRetryImport`).
            if (mayRetryImport(error)) {
                await ctx.runMutation(internal.lib.claim_once.releaseKey, { key: claimId, scope: IMPORT_CLAIM_SCOPE }).catch(() => undefined);
            }

            throw error instanceof BundleImportError ? new LunoraError("BAD_REQUEST", error.message) : error;
        }
    });
