/**
 * User-defined thread tags.
 *
 * Tags live in `threadTags` and are assigned by id on `threads.tagIds`. Both
 * tables are sharded by `userId`, so every write here — including the cascade
 * that strips a deleted tag from threads — runs inside the owner's shard.
 *
 * There is deliberately no list query: the tags ride along with
 * `chat_composite.getThreadListData`, which is already a first-paint query.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx as MutationContext } from "../../_generated/server";
import { patchThread } from "../../agent/table-writes";
import { authMutation, rateLimit } from "../../lib/crpc";
import type { ThreadTagColor } from "./logic";
import {
    hasDuplicateTagName,
    MAX_TAGS_PER_THREAD,
    MAX_THREAD_TAGS_PER_USER,
    nextTagOrder,
    normalizeTagName,
    validateTagName,
    validateTagReorder,
    withTagAssignment,
} from "./logic";
import { withoutUndefined } from "../../lib/patch";
import { MAX_LENGTH } from "../../lib/validators";

/**
 * Spelled out as literals because codegen cannot resolve a union built by a
 * call (`THREAD_TAG_COLORS.map(v.literal)`); `v.from(...)` at the use sites is
 * what lets it read this const. The assertion below fails to compile if this
 * drifts from `THREAD_TAG_COLORS`, which the web app renders from — and so
 * does the `threadTags.color` column, which `schema.ts` spells out the same way.
 */
const vThreadTagColor = v.union(
    v.literal("gray"),
    v.literal("red"),
    v.literal("orange"),
    v.literal("amber"),
    v.literal("green"),
    v.literal("teal"),
    v.literal("blue"),
    v.literal("violet"),
    v.literal("pink"),
);

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const colorValidatorMatchesPalette: Equal<Infer<typeof vThreadTagColor>, ThreadTagColor> = true;
const colorColumnMatchesPalette: Equal<Doc<"threadTags">["color"], ThreadTagColor> = true;

// eslint-disable-next-line sonarjs/void-use -- type-level assertions; `void` only marks the bindings as used.
void [colorValidatorMatchesPalette, colorColumnMatchesPalette];

const listUserTags = async (context: MutationContext, userId: string): Promise<Doc<"threadTags">[]> =>
    await context.db
        .query("threadTags")
        .withIndex("by_user_and_order", (q) => q.eq("userId", userId))
        .take(MAX_THREAD_TAGS_PER_USER);

/** Loads a tag and asserts the caller owns it. */
const requireOwnedTag = async (context: MutationContext, tagId: Id<"threadTags">, userId: string): Promise<Doc<"threadTags">> => {
    const tag = await context.db.get(tagId);

    if (!tag) {
        throw new LunoraError("NOT_FOUND", "Tag not found");
    }

    if (tag.userId !== userId) {
        throw new LunoraError("FORBIDDEN", "Cannot modify another user's tag");
    }

    return tag;
};

const requireValidName = (rawName: string): string => {
    const name = normalizeTagName(rawName);
    const error = validateTagName(name);

    if (error) {
        throw new LunoraError("BAD_REQUEST", error);
    }

    return name;
};

export const createThreadTag = authMutation
    .use(rateLimit("chat/update"))
    .input({
        color: v.from(vThreadTagColor),
        name: v.string().max(MAX_LENGTH.short),
    })
    .output(v.object({ tagId: v.string() }))
    .mutation(async ({ args: { color, name: rawName }, ctx: context }) => {
        const { userId } = context.user;
        const name = requireValidName(rawName);
        const existing = await listUserTags(context, userId);

        if (existing.length >= MAX_THREAD_TAGS_PER_USER) {
            throw new LunoraError("BAD_REQUEST", `You can create at most ${MAX_THREAD_TAGS_PER_USER} tags`);
        }

        if (hasDuplicateTagName(name, existing)) {
            throw new LunoraError("CONFLICT", "A tag with this name already exists");
        }

        const now = context.now;
        const tagId = await context.db.insert("threadTags", {
            color,
            createdAt: now,
            name,
            order: nextTagOrder(existing),
            updatedAt: now,
            userId,
        });

        context.log.event("chat.create_thread_tag", { tagCount: existing.length + 1 });

        return { tagId };
    });

export const updateThreadTag = authMutation
    .use(rateLimit("chat/update"))
    .input({
        color: v.optional(v.from(vThreadTagColor)),
        name: v.optional(v.string().max(MAX_LENGTH.short)),
        tagId: v.id("threadTags"),
    })
    .output(v.null())
    .mutation(async ({ args: { color, name: rawName, tagId }, ctx: context }) => {
        const { userId } = context.user;

        await requireOwnedTag(context, tagId, userId);

        const patch: Partial<Pick<Doc<"threadTags">, "color" | "name">> = {};

        if (rawName !== undefined) {
            const name = requireValidName(rawName);

            if (hasDuplicateTagName(name, await listUserTags(context, userId), tagId)) {
                throw new LunoraError("CONFLICT", "A tag with this name already exists");
            }

            patch.name = name;
        }

        if (color !== undefined) {
            patch.color = color;
        }

        await context.db.patch(tagId, withoutUndefined({ ...patch, updatedAt: context.now }));

        context.log.event("chat.update_thread_tag", { colorChanged: color !== undefined, nameChanged: rawName !== undefined });

        return null;
    });

export const reorderThreadTags = authMutation
    .use(rateLimit("chat/update"))
    .input({
        tagIds: v.array(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.null())
    .mutation(async ({ args: { tagIds }, ctx: context }) => {
        const { userId } = context.user;
        const existing = await listUserTags(context, userId);
        const error = validateTagReorder(
            tagIds,
            existing.map((tag) => tag._id as string),
        );

        if (error) {
            throw new LunoraError("BAD_REQUEST", error);
        }

        const now = context.now;

        await Promise.all(tagIds.map((tagId, order) => context.db.patch(tagId as Id<"threadTags">, { order, updatedAt: now })));

        context.log.event("chat.reorder_thread_tags", { requested: tagIds.length });

        return null;
    });

export const deleteThreadTag = authMutation
    .use(rateLimit("chat/update"))
    .input({
        tagId: v.id("threadTags"),
    })
    .output(v.object({ updatedThreads: v.number() }))
    .mutation(async ({ args: { tagId }, ctx: context }) => {
        const { userId } = context.user;

        await requireOwnedTag(context, tagId, userId);

        // No index can answer "threads carrying tag X" (array columns are not
        // indexable), so walk the owner's threads. Unbounded on purpose: a
        // capped read would leave dangling ids on the threads past the cap.
        const threads = await context.db
            .query("threads")
            .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
            .collect();
        const tagged = threads.filter((thread) => thread.tagIds?.includes(tagId));

        await Promise.all(tagged.map((thread) => patchThread(context.db, thread._id, { tagIds: withTagAssignment(thread.tagIds, tagId, false) })));
        await context.db.delete(tagId);

        context.log.event("chat.delete_thread_tag", { updatedThreads: tagged.length });

        return { updatedThreads: tagged.length };
    });

export const setThreadTagAssigned = authMutation
    .use(rateLimit("chat/update"))
    .input({
        assigned: v.boolean(),
        tagId: v.id("threadTags"),
        threadId: v.id("threads"),
    })
    .output(v.object({ tagIds: v.array(v.string()) }))
    .mutation(async ({ args: { assigned, tagId, threadId }, ctx: context }) => {
        const { userId } = context.user;
        const thread = await context.db.get(threadId);

        if (!thread || thread.deleted) {
            throw new LunoraError("NOT_FOUND", "Thread not found");
        }

        if (thread.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Cannot tag another user's thread");
        }

        // Ownership of the tag matters even on removal: it keeps a caller from
        // probing which tag ids exist.
        await requireOwnedTag(context, tagId, userId);

        const tagIds = withTagAssignment(thread.tagIds, tagId, assigned);

        if (tagIds.length > MAX_TAGS_PER_THREAD) {
            throw new LunoraError("BAD_REQUEST", `A thread can carry at most ${MAX_TAGS_PER_THREAD} tags`);
        }

        await patchThread(context.db, threadId, { tagIds });

        context.log.event("chat.set_thread_tag_assigned", { assigned, tagCount: tagIds.length });

        return { tagIds };
    });
