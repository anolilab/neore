/**
 * Applying an update, in internal mutations the update action calls in order:
 *   1. `beginUpdate` takes the install's lease (status `updating`, a new generation);
 *   2. `updateSkillChild`, `updateTriggerChild` and `updateGroupChild` rewrite one unedited child in place, after setting the
 *      child's pending hash;
 *   3. `retireGroupChild` and `dropGroupLink` remove a group chat the new version drops, `removeChild` and `detachChild` the
 *      other dropped children;
 *   4. `finishUpdate` returns the install to `installed` at the new version.
 *
 * Every step checks the generation, so a stale action writes nothing. A child whose live content is not the
 * installed content is refused inside the same mutation that would write it. The pending hash is cleared to "",
 * which means "none": the schema has no way to clear an optional field.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { normalizeGroupOptions, validateParticipantIds } from "../chat/group/logic";
import { vGroupChatMode } from "../chat/group/validators";
import { watchesSomethingElse } from "../triggers/event-sources";
import {
    assertBotRoutineOptions,
    assertCronExpression,
    assertCustomModelRunnable,
    assertTimeZone,
    assertWebhookTemplateFits,
    checkedEventSource,
    cleanPromptField,
    deleteTriggerRows,
    insertTrigger,
    triggerCreateFields,
    triggerTypeSchema,
    webhookSetup,
} from "../triggers/functions";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { patchRow } from "../lib/patch";
import { groupRowHash, normalizeGroupTitle, skillRowHash, triggerRowHash } from "./entry-hash";
import { skillVisibility } from "../skills/access";
import { invalidateSkillsCache } from "../skills/cache";
import { deleteSkillRows } from "../skills/functions";
import { ensureSlugUnique, validateSlug } from "../skills/validators";
import { heldInstall, heldInstallForShardWrite, patchInstallIf } from "./held-install";
import { liveHashOf } from "./live-hash";
import { LEASE_MS, markerFor, parseMarker } from "./logic";
import { refuseWhileErasing } from "./owner-shard";

/** The same bound uninstall uses when it looks for group chats that name a skill. */
const GROUP_SCAN_LIMIT = 300;

export const beginUpdate = internalMutation
    .input({ expectedGeneration: v.number(), installId: v.string().max(128), targetVersion: v.string().max(32), userId: v.string().max(128) })
    .output(v.number())
    .mutation(async ({ args, ctx }) => {
        await refuseWhileErasing(ctx, args.userId);

        const install = await ctx.db.pluginInstalls.findFirst({
            consistency: "primary",
            where: { _id: args.installId as Id<"pluginInstalls">, userId: args.userId },
        });

        if (!install) {
            throw new LunoraError("NOT_FOUND", "The plugin is not installed");
        }

        if (install.status !== "installed") {
            throw new LunoraError("CONFLICT", `The plugin is ${install.status}, not installed`);
        }

        // The plan was made from the install as it was read: if another update finished since, the plan is stale and the caller must preview again.
        if (install.generation !== args.expectedGeneration) {
            throw new LunoraError("CONFLICT", "The plugin changed while this update was being prepared. Preview it again.");
        }

        const generation = install.generation + 1;

        // Conditional on the generation that was read: of two callers with the same plan, one takes the lease and the other is told to preview again.
        await patchInstallIf(
            ctx,
            args.installId as Id<"pluginInstalls">,
            install.generation,
            {
                generation,
                leaseUntil: ctx.now + LEASE_MS,
                status: "updating",
                targetVersion: args.targetVersion,
                updatedAt: ctx.now,
            },
            "The plugin changed while this update was being prepared. Preview it again.",
            "installed",
        );

        return generation;
    });

export const updateSkillChild = internalMutation
    .input({
        category: v.optional(v.string().max(128)),
        config: v.optional(v.any()),
        contentHash: v.string().max(128),
        description: v.string().max(4096),
        entryKey: v.string().max(256),
        generation: v.number(),
        icon: v.optional(v.string().max(2048)),
        installId: v.string().max(128),
        instructions: v.string().max(65_536),
        name: v.string().max(256),
        /** The plugin version this update brings: the skill's `source` records it. */
        pluginVersion: v.string().max(32),
        slug: v.string().max(256),
        tags: v.optional(v.array(v.string().max(256))),
        userId: v.string().max(128),
        variables: v.optional(v.any()),
        version: v.optional(v.string().max(64)),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);
        // The rewrite can add a history row; an erasure that began after `beginUpdate` must not find one written behind its sweep.
        await refuseWhileErasing(ctx, args.userId);

        const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId: args.installId } });
        const link = page.find((row) => row.entryKey === args.entryKey && row.kind === "skill");

        if (!link || link.state !== "created") {
            throw new LunoraError("CONFLICT", `The child "${args.entryKey}" is not a linked skill of this plugin`);
        }

        const skill = await ctx.db.skills.findFirst({ consistency: "primary", where: { pluginMarker: markerFor(args.installId, args.entryKey) } });

        if (!skill || skill.userId !== args.userId) {
            throw new LunoraError("CONFLICT", `The skill for "${args.entryKey}" is missing`);
        }

        if ((await skillRowHash(skill)) !== link.contentHash) {
            throw new LunoraError("CONFLICT", `The skill for "${args.entryKey}" was edited, so it is kept as it is`);
        }

        // Visibility is not part of the content hash. A skill shared beyond its owner is used by others, so it is not rewritten. It
        // stays linked, as an edited skill does: the file still holds its key, so an unlinked skill would be created again next time.
        if (skillVisibility(skill) !== "private") {
            return false;
        }

        // The planned slug gets the same checks skill creation gives it: a reserved or malformed slug is refused, and so is one another skill now holds.
        const slugValidation = validateSlug(args.slug);

        if (!slugValidation.valid) {
            throw new LunoraError("BAD_REQUEST", slugValidation.errors.join(", "));
        }

        await ensureSlugUnique(ctx, skill.userId, args.slug, skill._id);

        // Pending first: if the write below stops, repair sees a child that matches neither hash and knows an update was half done.
        await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { pendingHash: args.contentHash });

        // The content a revision records: a change to it is a new version in the skill's history, as an edit by the owner would be.
        const contentChanged =
            args.instructions !== skill.instructions ||
            JSON.stringify(args.variables) !== JSON.stringify(skill.variables) ||
            JSON.stringify(args.config) !== JSON.stringify(skill.config);
        const currentVersion = (skill.currentVersion || 1) + (contentChanged ? 1 : 0);

        if (contentChanged) {
            await ctx.db.insert("skillHistory", {
                changeType: "plugin-update",
                config: args.config,
                createdAt: ctx.now,
                instructions: args.instructions,
                note: "Plugin update",
                skillId: skill._id,
                userId: skill.userId,
                variables: args.variables,
                version: currentVersion,
            });
        }

        // The slug is part of the content hash, so the row must take the planned slug or it reads as edited on the next update.
        // A field the new version leaves out is removed, so the row matches the hash recorded below.
        await patchRow(ctx.db, "skills", skill, {
            category: args.category,
            config: args.config,
            currentVersion,
            description: args.description,
            icon: args.icon,
            instructions: args.instructions,
            name: args.name,
            slug: args.slug,
            // Not part of the content hash: it says which plugin version the skill came from.
            source: { type: "plugin" as const, version: args.pluginVersion },
            tags: args.tags,
            updatedAt: ctx.now,
            variables: args.variables,
            version: args.version,
        });

        await invalidateSkillsCache(ctx, skill.userId);

        await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { contentHash: args.contentHash, pendingHash: "" });

        return true;
    });

export const finishUpdate = internalMutation
    .input({
        contentHash: v.string().max(128),
        generation: v.number(),
        installId: v.string().max(128),
        /** Some step was skipped or kept: the install takes the new version while a child holds other content, so export must not call it complete. */
        partial: v.boolean(),
        version: v.string().max(32),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        await patchInstallIf(ctx, args.installId as Id<"pluginInstalls">, args.generation, {
            contentHash: args.contentHash,
            partial: args.partial,
            status: "installed",
            updatedAt: ctx.now,
            version: args.version,
        });

        return null;
    });

/** Whether the child a link names is still there, looked up by its marker. */
const childExists = async (ctx: Pick<MutationCtx, "db">, link: { entryKey: string; kind: string }, installId: string): Promise<boolean> => {
    const marker = markerFor(installId, link.entryKey);

    if (link.kind === "skill") {
        return (await ctx.db.skills.findFirst({ consistency: "primary", where: { pluginMarker: marker } })) !== null;
    }

    const table = link.kind === "trigger" ? "triggers" : "threads";
    const row = await ctx.db
        .query(table)
        .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", marker))
        .first();

    return row !== null;
};

/**
 * An update that stopped on an error. Every child step is one mutation, so each child is either at the old content or the new
 * one, and running the update again finishes what is left. Normally the install goes back to `installed` at its old version and
 * the intent rows of creations that were rolled back are removed. When rows could not be removed or a rate limit kept them
 * (`keepForRepair`), the install is `needs-repair` and holds the new file's hash, so repair accepts the new file to finish them.
 */
export const failUpdate = internalMutation
    .input({
        contentHash: v.string().max(128),
        /** The entry keys this update tried to create. A link among them whose child the rollback removed is dropped, so the next update creates it again. */
        createKeys: v.array(v.string().max(256)),
        generation: v.number(),
        installId: v.string().max(128),
        keepForRepair: v.boolean(),
        /** Some child was rewritten, removed or created before the failure, so the old version no longer describes every child. */
        partial: v.boolean(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        if (args.keepForRepair) {
            await patchInstallIf(ctx, args.installId as Id<"pluginInstalls">, args.generation, {
                contentHash: args.contentHash,
                partial: true,
                status: "needs-repair",
                updatedAt: ctx.now,
            });

            return null;
        }

        const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId: args.installId } });
        let { partial } = args;

        // A step that stopped between its row write and its link write left a pending hash: a child at the pending content is adopted, one
        // still at the installed content is cleared, as repair does. A child that was adopted holds new content, so the install is partial.
        for (const row of page) {
            if (!row.pendingHash || row.state !== "created") {
                continue;
            }

            const live = await liveHashOf(ctx, args.installId, row);

            if (live === row.pendingHash) {
                await ctx.db.patch("pluginItems", row._id as Id<"pluginItems">, { contentHash: row.pendingHash, pendingHash: "" });
                partial = true;
            } else if (live === row.contentHash) {
                await ctx.db.patch("pluginItems", row._id as Id<"pluginItems">, { pendingHash: "" });
            }
        }

        // Only the links of this attempt: its intents (an intent has no child yet) and the links of the children it created whose
        // rollback removed the child. The install is released afterwards, so no new update can record links while this runs.
        for (const row of page) {
            if (!args.createKeys.includes(row.entryKey)) {
                continue;
            }

            if (row.state === "intent" || (row.state === "created" && !(await childExists(ctx, row, args.installId)))) {
                await ctx.db.delete("pluginItems", row._id as Id<"pluginItems">);
            }
        }

        await patchInstallIf(ctx, args.installId as Id<"pluginInstalls">, args.generation, { partial, status: "installed", updatedAt: ctx.now });

        return null;
    });

/**
 * Rewrites one unedited trigger of any type to the new version's content. Every field the entry hash covers is stored the way
 * trigger creation stores it, and the same checks run. The trigger is switched off: a changed trigger must be read and re-enabled
 * by the person, so new content never runs unseen. When the type stays the same the row is patched, so a webhook keeps its id,
 * URL and secret. When the type changes the old row and its runs are deleted and a new one is created under the same marker in the
 * same mutation; a new webhook's secret is returned once. An edited trigger is refused (`CONFLICT`) and left as it is.
 */
export const updateTriggerChild = internalMutation
    .input({
        ...triggerCreateFields,
        contentHash: v.string().max(128),
        entryKey: v.string().max(256),
        generation: v.number(),
        installId: v.string().max(128),
        userId: v.string().max(128),
    })
    .output(v.object({ webhookSecret: v.optional(v.string()) }))
    .mutation(async ({ args, ctx }) => {
        await heldInstallForShardWrite(ctx, args.installId as Id<"pluginInstalls">, args.generation);
        // A type change creates a row and a route; an erasure that began after `beginUpdate` must not find them behind its sweep.
        await refuseWhileErasing(ctx, args.userId);

        const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId: args.installId } });
        const link = page.find((row) => row.entryKey === args.entryKey && row.kind === "trigger");

        if (!link || link.state !== "created") {
            throw new LunoraError("CONFLICT", `The child "${args.entryKey}" is not a linked trigger of this plugin`);
        }

        const trigger = await ctx.db
            .query("triggers")
            .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", markerFor(args.installId, args.entryKey)))
            .first();

        if (!trigger || trigger.userId !== args.userId) {
            throw new LunoraError("CONFLICT", `The trigger for "${args.entryKey}" is missing`);
        }

        if ((await triggerRowHash(trigger)) !== link.contentHash) {
            throw new LunoraError("CONFLICT", `The trigger for "${args.entryKey}" was edited, so it is kept as it is`);
        }

        const { contentHash, entryKey, installId, userId, ...fields } = args; // `fields` also holds `generation`, which no write below reads
        const type = triggerTypeSchema.parse(fields.type);
        const linkId = link._id as Id<"pluginItems">;

        if (trigger.type !== type) {
            // Pending first, as for any rewrite. The delete and the create are one transaction: a failed create leaves the old row.
            await ctx.db.patch("pluginItems", linkId, { pendingHash: contentHash });
            await deleteTriggerRows(ctx, trigger._id as Id<"triggers">);

            const created = await insertTrigger(ctx, { organizationId: trigger.organizationId, userId }, fields, {
                pluginInstallId: installId,
                pluginMarker: markerFor(installId, entryKey),
            });

            await ctx.db.patch("pluginItems", linkId, { contentHash, pendingHash: "" });

            return created.webhookSecret === undefined ? {} : { webhookSecret: created.webhookSecret };
        }

        // The checks creation makes, on the state the row ends up in.
        await assertCustomModelRunnable(ctx, fields.model, userId);

        const timezone = fields.timezone?.trim() || undefined;

        if (timezone !== undefined) {
            assertTimeZone(timezone);
        }

        if (fields.cronExpression !== undefined || type === "schedule") {
            assertCronExpression(fields.cronExpression ?? "");
        }

        const bot = fields.botId ? await ctx.runQuery(internal.bots.functions.getBotForRun, { botId: fields.botId, userId }) : null;

        if (fields.botId && !bot) {
            throw new LunoraError("NOT_FOUND", "Bot not found");
        }

        if (bot) {
            await assertCustomModelRunnable(ctx, bot.model, userId);
        }

        assertBotRoutineOptions({ botComputer: fields.botComputer === true, botId: fields.botId, quietWhenEmpty: fields.quietWhenEmpty === true, type });

        const { filters, webhookSignatureScheme } = webhookSetup(fields, type);
        const eventSource = await checkedEventSource(ctx, fields.eventSource, type, userId, ctx.now);
        // Stored cleaned, the way trigger creation stores it, which is also what the entry hash is computed over.
        const inputTemplate = cleanPromptField(fields.inputTemplate, "The input");

        assertWebhookTemplateFits(type, inputTemplate);

        const systemPrompt = cleanPromptField(fields.systemPrompt, "The system prompt");

        await ctx.db.patch("pluginItems", linkId, { pendingHash: contentHash });

        // Watching something else forgets the old baseline. The trigger is switched off, so enabling arms it again.
        const sourceChanged = type === "event" && eventSource !== undefined && watchesSomethingElse(trigger.eventSource, eventSource);
        const scheduleChanged = type === "schedule" && (fields.cronExpression !== trigger.cronExpression || timezone !== trigger.timezone);

        // A field the new version leaves out is removed, so the row matches the hash recorded below.
        await patchRow(ctx.db, "triggers", trigger, {
            botComputer: fields.botComputer === true ? true : undefined,
            botId: fields.botId as Id<"bots"> | undefined,
            cronExpression: fields.cronExpression,
            description: fields.description,
            enabled: false,
            eventSource,
            filters,
            inputTemplate,
            model: fields.model,
            name: fields.name,
            quietWhenEmpty: fields.quietWhenEmpty === true ? true : undefined,
            searchMode: fields.searchMode,
            systemPrompt,
            timezone,
            updatedAt: ctx.now,
            webhookSignatureScheme,
            // A changed schedule must not keep the due time of the old one: undefined removes it, and enabling recomputes it. An unchanged schedule keeps it.
            ...((scheduleChanged || sourceChanged) && { nextTriggerAt: undefined }),
            ...(sourceChanged && { eventState: {} }),
        });

        await ctx.db.patch("pluginItems", linkId, { contentHash, pendingHash: "" });

        return {};
    });

/** The child's link, by its entry key, after the generation check. An entry key carries its kind (`skill:analyst`), so it names one link. */
const linkFor = async (ctx: Pick<MutationCtx, "db">, installId: string, entryKey: string) => {
    const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId } });

    return page.find((row) => row.entryKey === entryKey);
};

/** A group chat of the owner that names the skill as a participant or synthesizer, if any. Too many conversations to scan counts as a user. */
const groupUsing = async (ctx: Pick<MutationCtx, "db">, skillId: string, userId: string): Promise<boolean> => {
    const threads = await ctx.db
        .query("threads")
        .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId))
        .take(GROUP_SCAN_LIMIT);

    return (
        threads.length >= GROUP_SCAN_LIMIT ||
        threads.some(
            (thread) =>
                thread.groupChat?.synthesizerSkillId === skillId || thread.groupChat?.participants.some((participant) => participant.skillId === skillId),
        )
    );
};

/**
 * Removes an unedited child that the new version no longer has: its row, then its link. A child whose content is not what was
 * installed is refused here too, so the check does not depend on the diff having been current. A skill that a group chat still
 * names, or one shared beyond its owner, is kept (the result is `false`), so the group keeps its participant; it is detached (marker cleared, link deleted), so the plugin no longer holds a child its file lacks.
 */
export const removeChild = internalMutation
    .input({
        entryKey: v.string().max(256),
        generation: v.number(),
        installId: v.string().max(128),
        userId: v.string().max(128),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        await heldInstallForShardWrite(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const link = await linkFor(ctx, args.installId, args.entryKey);

        if (!link) {
            return true;
        }

        if (link.kind === "skill") {
            const skill = await ctx.db.skills.findFirst({ consistency: "primary", where: { pluginMarker: markerFor(args.installId, args.entryKey) } });

            if (skill && skill.userId === args.userId) {
                if ((await skillRowHash(skill)) !== link.contentHash) {
                    throw new LunoraError("CONFLICT", `The skill for "${args.entryKey}" was edited, so it is kept`);
                }

                // A skill shared beyond its owner may sit in another person's group chat, on a shard this step cannot scan, and a skill
                // the owner's own group chat names must keep its participant. Either is kept, detached from the plugin that no longer has it.
                if (skillVisibility(skill) !== "private" || (await groupUsing(ctx, skill._id as string, args.userId))) {
                    await ctx.db.patch("skills", skill._id as Id<"skills">, { pluginInstallId: "", pluginMarker: "" });
                    await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);

                    return false;
                }

                await deleteSkillRows(ctx, skill._id as Id<"skills">, args.userId);
            }
        } else if (link.kind === "trigger") {
            const trigger = await ctx.db
                .query("triggers")
                .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", markerFor(args.installId, args.entryKey)))
                .first();

            if (trigger && trigger.userId === args.userId) {
                if ((await triggerRowHash(trigger)) !== link.contentHash) {
                    throw new LunoraError("CONFLICT", `The trigger for "${args.entryKey}" was edited, so it is kept`);
                }

                await deleteTriggerRows(ctx, trigger._id as Id<"triggers">);
            }
        } else {
            throw new LunoraError("CONFLICT", `"${args.entryKey}" is a group chat, which is removed through retireGroupChild`);
        }

        await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);

        return true;
    });

/**
 * Keeps an edited child that the new version no longer has: its marker fields are cleared, so no later sweep finds it, and a
 * trigger is switched off. The link is deleted, so the child is no longer counted as part of the plugin.
 */
export const detachChild = internalMutation
    .input({
        entryKey: v.string().max(256),
        generation: v.number(),
        installId: v.string().max(128),
        userId: v.string().max(128),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstallForShardWrite(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const link = await linkFor(ctx, args.installId, args.entryKey);

        if (!link) {
            return null;
        }

        const marker = markerFor(args.installId, args.entryKey);

        if (link.kind === "skill") {
            const skill = await ctx.db.skills.findFirst({ consistency: "primary", where: { pluginMarker: marker } });

            if (skill && skill.userId === args.userId) {
                await ctx.db.patch("skills", skill._id as Id<"skills">, { pluginInstallId: "", pluginMarker: "" });
            }
        } else if (link.kind === "trigger") {
            const trigger = await ctx.db
                .query("triggers")
                .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", marker))
                .first();

            if (trigger && trigger.userId === args.userId) {
                await ctx.db.patch("triggers", trigger._id as Id<"triggers">, { enabled: false, pluginInstallId: "", pluginMarker: "" });
            }
        } else {
            throw new LunoraError("CONFLICT", `"${args.entryKey}" is a group chat, which is detached through retireGroupChild`);
        }

        // The link goes with the marker: a detached child is no longer part of the plugin, so a later version that brings the key back creates it afresh.
        await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);

        return null;
    });

/**
 * The plugin's skills by entry key and by id, read from the primary in pages (one statement a page, 25 skills each). A group's
 * participants are mapped through these: the same mapping the live hash uses (`liveHashOf`), so a group rewritten here reads
 * as unedited afterwards.
 */
const pluginSkillMaps = async (ctx: Pick<MutationCtx, "db">, installId: string, userId: string) => {
    const idByKey = new Map<string, string>();
    const keyById = new Map<string, string>();
    let cursor: string | null = null;

    for (;;) {
        const result: { continueCursor?: string | null; isDone: boolean; page: { _id: unknown; pluginMarker?: string; userId: string }[] } =
            await ctx.db.skills.findMany({ consistency: "primary", cursor, where: { pluginInstallId: installId } });

        for (const skill of result.page) {
            const parsed = parseMarker(skill.pluginMarker ?? "");

            if (skill.userId === userId && parsed?.installId === installId) {
                idByKey.set(parsed.entryKey, skill._id as string);
                keyById.set(skill._id as string, parsed.entryKey);
            }
        }

        if (result.isDone || !result.continueCursor) {
            return { idByKey, keyById };
        }

        cursor = result.continueCursor;
    }
};

/** A group thread's live hash: its stored fields, with each participant named by its plugin entry key. */
const groupThreadHash = async (thread: Doc<"threads">, keyById: ReadonlyMap<string, string>): Promise<string> =>
    await groupRowHash(
        {
            debateRounds: thread.groupChat?.debateRounds,
            mode: thread.groupChat?.mode ?? "",
            model: thread.model ?? "",
            participants: thread.groupChat?.participants ?? [],
            synthesizerSkillId: thread.groupChat?.synthesizerSkillId,
            title: thread.title,
        },
        (skillId) => keyById.get(skillId),
    );

/** The group thread a marker names, if it is the owner's. */
const groupThreadFor = async (ctx: Pick<MutationCtx, "db">, installId: string, entryKey: string, userId: string) => {
    const thread = await ctx.db
        .query("threads")
        .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", markerFor(installId, entryKey)))
        .first();

    return thread && thread.userId === userId ? thread : null;
};

/**
 * Rewrites one unedited group chat to the new version's definition, in place: title, mode, model, participants, synthesizer and
 * debate rounds. The messages stay. Participants are named by entry key and mapped to the plugin's skills here, and are stored the
 * way a new group stores them (`{ addedAt, skillId }`, the options its mode uses), so the entry hash matches the live hash afterwards.
 * A participant that is not a live skill of this plugin, or a group that was edited since the preview, is refused (`CONFLICT`) before
 * anything is written. The link's pending hash brackets the write, as for a skill.
 *
 * D1 statements: the install row, one link read, one read of the plugin's skills per 25 skills, and two link patches.
 */
export const updateGroupChild = internalMutation
    .input({
        contentHash: v.string().max(128),
        debateRounds: v.optional(v.number()),
        entryKey: v.string().max(256),
        generation: v.number(),
        installId: v.string().max(128),
        mode: vGroupChatMode,
        model: v.string().max(256),
        /** Entry keys of the participant skills, in order. */
        participantKeys: v.array(v.string().max(256)),
        synthesizerKey: v.optional(v.string().max(256)),
        title: v.string().max(512),
        userId: v.string().max(128),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstallForShardWrite(ctx, args.installId as Id<"pluginInstalls">, args.generation);
        await refuseWhileErasing(ctx, args.userId);

        const { page: links } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId: args.installId } });
        const link = links.find((row) => row.entryKey === args.entryKey && row.kind === "group");

        if (!link || link.state !== "created") {
            throw new LunoraError("CONFLICT", `The child "${args.entryKey}" is not a linked group chat of this plugin`);
        }

        const thread = await groupThreadFor(ctx, args.installId, args.entryKey, args.userId);

        if (!thread?.groupChat) {
            throw new LunoraError("CONFLICT", `The group chat for "${args.entryKey}" is missing`);
        }

        const { idByKey, keyById } = await pluginSkillMaps(ctx, args.installId, args.userId);

        if ((await groupThreadHash(thread, keyById)) !== link.contentHash) {
            throw new LunoraError("CONFLICT", `The group chat for "${args.entryKey}" was edited, so it is kept as it is`);
        }

        const unresolved = [...args.participantKeys, ...(args.synthesizerKey === undefined ? [] : [args.synthesizerKey])].filter((key) => !idByKey.has(key));

        if (unresolved.length > 0) {
            throw new LunoraError(
                "CONFLICT",
                `The group chat "${args.title}" names ${[...new Set(unresolved)].join(", ")}, which is not a skill of this plugin`,
            );
        }

        if (args.participantKeys.length < 2) {
            throw new LunoraError("BAD_REQUEST", "A group chat needs at least two participants");
        }

        const skillIds = args.participantKeys.flatMap((key) => idByKey.get(key) ?? []);
        const synthesizerSkillId = args.synthesizerKey === undefined ? undefined : idByKey.get(args.synthesizerKey);

        const participantError = validateParticipantIds(skillIds, () => true);

        if (participantError) {
            throw new LunoraError("BAD_REQUEST", participantError);
        }

        const options = normalizeGroupOptions({ debateRounds: args.debateRounds, mode: args.mode, skillIds, synthesizerSkillId });

        if ("error" in options) {
            throw new LunoraError("BAD_REQUEST", options.error);
        }

        const linkId = link._id as Id<"pluginItems">;
        const stored = thread.groupChat;
        const addedAt = new Map(stored.participants.map((participant) => [participant.skillId, participant.addedAt]));

        // Pending first: if the write below stops, repair sees a child that matches neither hash and knows an update was half done.
        await ctx.db.patch("pluginItems", linkId, { pendingHash: args.contentHash });

        // A field the new version leaves out is removed (the whole group object is replaced), so the row matches the hash recorded below.
        await patchRow(ctx.db, "threads", thread, {
            groupChat: {
                ...options.options,
                mode: args.mode,
                participants: skillIds.map((skillId) => {
                    return { addedAt: addedAt.get(skillId) ?? ctx.now, skillId };
                }),
                ...(stored.stopRequestedAt !== undefined && { stopRequestedAt: stored.stopRequestedAt }),
            },
            model: args.model,
            title: normalizeGroupTitle(args.title),
        });

        await ctx.db.patch("pluginItems", linkId, { contentHash: args.contentHash, pendingHash: "" });

        return null;
    });

/**
 * Detaches a group chat from the plugin: marker and install id cleared, so no later sweep finds it. It does not touch the plugin's
 * skills the group names (unlike uninstall's `detachKeptGroup`): in an update those skills usually stay in the plugin.
 */
const detachGroupOnly = async (ctx: Pick<MutationCtx, "db">, thread: Doc<"threads"> | null, link: { _id: unknown }): Promise<void> => {
    if (thread) {
        await ctx.db.patch("threads", thread._id as Id<"threads">, { pluginInstallId: "", pluginMarker: "" });
    }

    await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);
};

/**
 * The first half of removing a group chat the new version drops. It says what the action does next:
 *   - `delete`: the group is unedited, empty and has no pins. It stays linked and attached until the action has deleted it in pages
 *     (`deleteAllForThreadIdAsync`, callable only from an action) and calls `dropGroupLink`;
 *   - `kept`: it has messages or pins (or was edited since the preview), so it is detached, with its link, and reported;
 *   - `detached`: the plan said it was edited, so it is detached, with its link;
 *   - `gone`: the thread no longer exists; its link is deleted.
 * A message or pin keeps a group, as at uninstall, and the plugin's skills it names are not detached. The skill removal that follows
 * keeps a skill a kept group still names (`removeChild`).
 *
 * D1 statements: the install row, one link read, one read of the plugin's skills per 25 skills, and the link delete.
 */
export const retireGroupChild = internalMutation
    .input({
        /** The plan detaches the group: it was edited. */
        detach: v.boolean(),
        entryKey: v.string().max(256),
        generation: v.number(),
        installId: v.string().max(128),
        userId: v.string().max(128),
    })
    .output(
        v.object({
            outcome: v.union(v.literal("delete"), v.literal("detached"), v.literal("gone"), v.literal("kept")),
            /** The thread to delete, for `delete`. */
            threadId: v.optional(v.string()),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        await heldInstallForShardWrite(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const link = await linkFor(ctx, args.installId, args.entryKey);

        if (!link) {
            return { outcome: "gone" };
        }

        const thread = await groupThreadFor(ctx, args.installId, args.entryKey, args.userId);

        if (!thread) {
            await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);

            return { outcome: "gone" };
        }

        if (args.detach) {
            await detachGroupOnly(ctx, thread, link);

            return { outcome: "detached" };
        }

        const threadId = thread._id as Id<"threads">;
        const message = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
            .first();

        // A pin keeps a group as a message does: its deletion needs a second page, and a stopped action could not find it again.
        const pin = message
            ? undefined
            : await ctx.db
                  .query("threadPins")
                  .withIndex("by_thread", (q) => q.eq("threadId", threadId))
                  .first();

        // The group may have been edited since the preview: it is kept, not deleted.
        let edited = false;

        if (!message && !pin) {
            const { keyById } = await pluginSkillMaps(ctx, args.installId, args.userId);

            edited = (await groupThreadHash(thread, keyById)) !== link.contentHash;
        }

        if (message || pin || edited) {
            await detachGroupOnly(ctx, thread, link);

            return { outcome: "kept" };
        }

        return { outcome: "delete", threadId };
    });

/** The second half of removing a group chat: its thread is deleted, so its link goes. */
export const dropGroupLink = internalMutation
    .input({ entryKey: v.string().max(256), generation: v.number(), installId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const link = await linkFor(ctx, args.installId, args.entryKey);

        if (link) {
            await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);
        }

        return null;
    });
