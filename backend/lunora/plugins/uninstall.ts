/**
 * Uninstall: removes a plugin's children and its install, in three steps.
 *
 *   1. `uninstallRows` (begin): refuses first, then takes the lease and sweeps. A group chat with messages refuses the whole
 *      uninstall, and so does a group chat of someone else that uses a skill of this plugin. An unedited skill is deleted with
 *      its rows. An edited skill is kept with its marker cleared. A trigger is kept and switched off. The plugin's own empty group
 *      chats are returned for deletion.
 *   2. The action deletes those empty group chats, in pages (`deleteAllForThreadIdAsync`, which is only callable from an action).
 *   3. `finishUninstallRows` removes the links and the install, once every child that was going to go has gone.
 *
 * Cleared fields are "" rather than absent: the schema cannot clear an optional field with a patch.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DEFAULT_GROUP_TITLE } from "../chat/group/functions";
import { skillVisibility } from "../skills/access";
import { requireOwnerShard } from "./owner-shard";
import { skillRowHash } from "./entry-hash";
import { patchInstallIf, STALE } from "./held-install";
import { LEASE_MS, parseMarker } from "./logic";
import { deleteSkillRows } from "../skills/functions";

/** How many of the owner's threads a scan reads. A scan that reaches it cannot prove a group is clear, so it refuses. */
const GROUP_SCAN_LIMIT = 300;

/** A page of rows, as `findMany` returns it. */
interface RowPage<T> {
    continueCursor?: string | null;
    isDone: boolean;
    page: T[];
}

/** Every row a `findMany` matches, page by page: one read stops at a page, and a missed row would be misjudged. */
const readAllPages = async <T>(read: (cursor: string | null) => Promise<RowPage<T>>): Promise<T[]> => {
    const rows: T[] = [];
    let cursor: string | null = null;

    for (;;) {
        const result: RowPage<T> = await read(cursor);

        rows.push(...result.page);

        if (result.isDone || !result.continueCursor) {
            return rows;
        }

        cursor = result.continueCursor;
    }
};

export interface UninstallBegun {
    generation: number;
    groups: string[];
    installId: string;
    kept: string[];
    /** Ids of unedited private skills that one of the plugin's own groups names. They go in the finish step, if no kept group needs them. */
    pendingSkills: string[];
    removed: number;
}

export const uninstallRows = async (ctx: MutationCtx, userId: string, pluginSlug: string): Promise<UninstallBegun> => {
    // The group chats, messages and skills scanned below live on the owner's shard. On another shard the scans would find
    // nothing, and the sweep would remove the global rows without the checks.
    requireOwnerShard(userId, "uninstall");

    const install = await ctx.db.pluginInstalls.findFirst({ consistency: "primary", where: { pluginSlug, userId } });

    if (!install) {
        throw new LunoraError("NOT_FOUND", `The plugin "${pluginSlug}" is not installed`);
    }

    if (["installing", "uninstalling", "updating"].includes(install.status) && install.leaseUntil !== undefined && install.leaseUntil > ctx.now) {
        throw new LunoraError("CONFLICT", `The plugin "${pluginSlug}" is busy. Try again in a few minutes.`);
    }

    const installId = install._id as string;
    const links = await readAllPages(async (cursor) => await ctx.db.pluginItems.findMany({ consistency: "primary", cursor, where: { installId } }));
    const skills = await readAllPages(
        async (cursor) => await ctx.db.skills.findMany({ consistency: "primary", cursor, where: { pluginInstallId: installId } }),
    );
    const skillIds = new Set(skills.map((skill) => skill._id as string));

    // The plugin's own group chats: any with messages refuses the uninstall; the empty ones go with it.
    const ownGroups = await ctx.db
        .query("threads")
        .withIndex("by_plugin_install", (q) => q.eq("pluginInstallId", installId))
        .take(GROUP_SCAN_LIMIT);

    if (ownGroups.length >= GROUP_SCAN_LIMIT) {
        throw new LunoraError("CONFLICT", "This plugin has too many group chats to remove in one step. Delete some of them first.");
    }

    const groups: string[] = [];

    for (const group of ownGroups) {
        const message = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", group._id as Id<"threads">))
            .first();

        if (message) {
            throw new LunoraError("CONFLICT", `"${group.title ?? "A group chat"}" has messages. Delete it yourself first, then uninstall the plugin.`);
        }

        groups.push(group._id as string);
    }

    let scanFull = false;

    if (skillIds.size > 0) {
        const threads = await ctx.db
            .query("threads")
            .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId))
            .take(GROUP_SCAN_LIMIT);

        // A scan that fills its page cannot prove no group chat uses a skill: the skills are kept and detached below, not deleted.
        scanFull = threads.length >= GROUP_SCAN_LIMIT;

        // The plugin's own groups use its skills by design; only someone else's group blocks.
        const user = threads.find(
            (thread) => thread.pluginInstallId !== installId && thread.groupChat?.participants.some((participant) => skillIds.has(participant.skillId)),
        );

        if (user) {
            throw new LunoraError("CONFLICT", `"${user.title ?? "A group chat"}" uses a skill of this plugin. Change that group chat first.`);
        }
    }

    const generation = install.generation + 1;

    // The claim is conditional on the generation and status read above: a repair that claimed the same install in between wins, and
    // this one is refused, so two actions never both believe they own it.
    await patchInstallIf(
        ctx,
        install._id as Id<"pluginInstalls">,
        install.generation,
        { generation, leaseUntil: ctx.now + LEASE_MS, status: "uninstalling", updatedAt: ctx.now },
        STALE,
        install.status,
    );

    const kept: string[] = [];
    const pendingSkills: string[] = [];

    for (const skill of skills) {
        const marker = parseMarker(skill.pluginMarker ?? "");
        const link = links.find((row) => row.entryKey === marker?.entryKey);
        // A skill shared beyond its owner may sit in another person's group chat, on a shard this step cannot scan: keep it.
        const edited = scanFull || !link || skillVisibility(skill) !== "private" || (await skillRowHash(skill)) !== link.contentHash;

        if (edited) {
            await ctx.db.patch("skills", skill._id as Id<"skills">, { pluginInstallId: "", pluginMarker: "" });
            kept.push(skill.name);
            continue;
        }

        // Deleting a skill is several D1 statements (stats, ratings, files, the row), so none is deleted here, after the claim: the
        // finish step deletes pending skills a few a call.
        pendingSkills.push(skill._id as string);
    }

    const triggers = await ctx.db
        .query("triggers")
        .withIndex("by_plugin_install", (q) => q.eq("pluginInstallId", installId))
        .collect();

    for (const trigger of triggers) {
        // Disabled as well: a kept trigger must not run after its plugin is gone.
        await ctx.db.patch("triggers", trigger._id as Id<"triggers">, { enabled: false, pluginInstallId: "", pluginMarker: "" });
        kept.push(trigger.name);
    }

    return { generation, groups, installId, kept, pendingSkills, removed: 0 };
};

/**
 * Keeps a group chat of the plugin: detaches it, and detaches the plugin's skills it names in the same transaction. Written in one
 * step so that an action that stops right after still leaves a state a retry can finish: a detached group that named skills still
 * owned by the plugin would otherwise read as someone else's group using them, and the retry would refuse for good.
 */
export const detachKeptGroup = async (ctx: MutationCtx, threadId: string, installId: string): Promise<void> => {
    const group = await ctx.db.get("threads", threadId as Id<"threads">);

    const participants = group?.groupChat?.participants ?? [];

    for (const participant of participants) {
        const skill = await ctx.db.skills.findFirst({ consistency: "primary", where: { _id: participant.skillId as Id<"skills"> } });

        if (skill?.pluginInstallId === installId) {
            await ctx.db.patch("skills", skill._id as Id<"skills">, { pluginInstallId: "", pluginMarker: "" });
        }
    }

    await ctx.db.patch("threads", threadId as Id<"threads">, { pluginInstallId: "", pluginMarker: "" });
};

/**
 * Run right before a group chat is deleted. The begin step checked it was empty, but that check and the delete are separate
 * transactions, so a message may have landed in between. Throwing here would strand a half-uninstalled plugin (skills swept,
 * lease held, begin refuses retries), so a group that now has messages is detached and kept instead.
 *
 * Returns `true` when the group may be deleted, `false` when it was kept.
 */
export const claimGroupForDelete = async (ctx: MutationCtx, installId: string, generation: number, threadId: string): Promise<boolean> => {
    const install = await ctx.db.pluginInstalls.findFirst({ consistency: "primary", where: { _id: installId as Id<"pluginInstalls"> } });

    if (!install || install.generation !== generation) {
        throw new LunoraError("CONFLICT", "STALE_LEASE: this uninstall was taken over by another action");
    }

    const thread = await ctx.db.get("threads", threadId as Id<"threads">);

    if (!thread || thread.pluginInstallId !== installId) {
        return false;
    }

    const message = await ctx.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId as Id<"threads">))
        .first();

    // A pin keeps a group as a message does: its deletion needs a second page, and a stopped action could not find it again.
    const pin = message
        ? undefined
        : await ctx.db
              .query("threadPins")
              .withIndex("by_thread", (q) => q.eq("threadId", threadId as Id<"threads">))
              .first();

    if (message || pin) {
        await detachKeptGroup(ctx, threadId, installId);

        return false;
    }

    return true;
};

export interface UninstallFinished {
    /** True while links are left: the caller calls again (with no pending skills or kept groups) until it is false. */
    hasMore: boolean;
    kept: string[];
    removed: number;
}

/**
 * Skills one finish call deletes. A delete reads the skill's stats, ratings and files and deletes them and the row (about eight D1
 * statements), plus the call's own reads for each skill: three stay well under an invocation's 50.
 */
export const SKILLS_PER_CALL = 3;

/** Links one finish call deletes: each is a read and a delete against the invocation's D1 queries. */
const LINKS_PER_CALL = 10;

/**
 * The last step: the held-back skills, the links and the install go. Called once the group chats have been deleted. A pending
 * skill that a kept group chat still names is detached instead of deleted, the way an edited skill is.
 */
export const finishUninstallRows = async (
    ctx: MutationCtx,
    installId: string,
    generation: number,
    options: { keptGroups?: string[]; pendingSkills?: string[]; settled?: boolean } = {},
): Promise<UninstallFinished> => {
    const install = await ctx.db.pluginInstalls.findFirst({ consistency: "primary", where: { _id: installId as Id<"pluginInstalls"> } });

    if (!install || install.generation !== generation || install.status !== "uninstalling") {
        throw new LunoraError("CONFLICT", "STALE_LEASE: this uninstall was taken over by another action");
    }

    requireOwnerShard(install.userId, "uninstall");

    const result: Omit<UninstallFinished, "hasMore"> = { kept: [], removed: 0 };
    const usedByKept = new Set<string>();

    const keptGroups = options.keptGroups ?? [];
    const allPending = options.pendingSkills ?? [];
    const pendingSkills = allPending.slice(0, SKILLS_PER_CALL);

    for (const threadId of keptGroups) {
        const group = await ctx.db.get("threads", threadId as Id<"threads">);

        // A kept group chat is reported by its title, never by its id, and once: the calls that follow the first are `settled`.
        if (group && options.settled !== true) {
            result.kept.push(group.title?.trim() || DEFAULT_GROUP_TITLE);
        }

        const participants = group?.groupChat?.participants ?? [];

        for (const participant of participants) {
            usedByKept.add(participant.skillId);
        }
    }

    const planned =
        pendingSkills.length > 0
            ? await readAllPages(async (cursor) => await ctx.db.pluginItems.findMany({ consistency: "primary", cursor, where: { installId } }))
            : [];

    // The owner's group chats, read once for the call: one may have gained a pending skill since begin. A scan that fills its page
    // cannot prove none does, so every skill is kept then, as at begin.
    let usedByOthers = new Set<string>();
    let scanFull = false;

    if (pendingSkills.length > 0) {
        const threads = await ctx.db
            .query("threads")
            .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", install.userId))
            .take(GROUP_SCAN_LIMIT);

        scanFull = threads.length >= GROUP_SCAN_LIMIT;
        usedByOthers = new Set(
            threads.flatMap((thread) =>
                thread.pluginInstallId === installId ? [] : (thread.groupChat?.participants.map((participant) => participant.skillId) ?? []),
            ),
        );
    }

    for (const skillId of pendingSkills) {
        const skill = await ctx.db.skills.findFirst({ consistency: "primary", where: { _id: skillId as Id<"skills"> } });

        if (!skill) {
            continue;
        }

        // Detached already, with the kept group that names it (`detachKeptGroup`): still reported as kept.
        if (skill.pluginInstallId !== installId) {
            if (usedByKept.has(skillId)) {
                result.kept.push(skill.name);
            }

            continue;
        }

        // Judged again as at begin: the owner may have edited or shared the skill while the groups were being deleted.
        const link = planned.find((row) => row.entryKey === parseMarker(skill.pluginMarker ?? "")?.entryKey);
        const changed = !link || skillVisibility(skill) !== "private" || (await skillRowHash(skill)) !== link.contentHash;

        if (usedByKept.has(skillId) || usedByOthers.has(skillId) || scanFull || changed) {
            await ctx.db.patch("skills", skill._id as Id<"skills">, { pluginInstallId: "", pluginMarker: "" });
            result.kept.push(skill.name);
            continue;
        }

        await deleteSkillRows(ctx, skill._id as Id<"skills">, install.userId);
        result.removed += 1;
    }

    // Skills first, a few a call; the links and the install wait for a call of their own, so no call adds link deletes on top of
    // skill deletes and passes the statement limit.
    if (allPending.length > 0) {
        return { ...result, hasMore: true };
    }

    const { page: links } = await ctx.db.pluginItems.findMany({ consistency: "primary", limit: LINKS_PER_CALL + 1, where: { installId } });

    for (const link of links.slice(0, LINKS_PER_CALL)) {
        await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);
    }

    // A link left behind would name an install that no longer exists, so the install goes last.
    if (links.length > LINKS_PER_CALL) {
        return { ...result, hasMore: true };
    }

    await ctx.db.delete("pluginInstalls", install._id as Id<"pluginInstalls">);

    return { ...result, hasMore: false };
};
