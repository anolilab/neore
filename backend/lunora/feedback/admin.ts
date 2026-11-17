/**
 * The admins' read of the feedback users send (`/admin/feedback`).
 *
 * `feedback` is owner-only under RLS; {@link listFeedback} reads across users
 * because it is an `adminQuery`, whose admin scope is the documented way past
 * that policy. Images go out as short-lived signed URLs, never their keys.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { adminQuery } from "../lib/crpc";
import { displayUrlExpiresInSeconds } from "../lib/storage-ref";
import { trySign } from "../lib/storage-sign";
import { MAX_LENGTH } from "../lib/validators";
import { vFeedbackKind } from "./validators";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const vFeedbackSender = v.object({
    email: v.union(v.string(), v.null()),
    image: v.union(v.string(), v.null()),
    name: v.union(v.string(), v.null()),
    userId: v.string(),
});

const vAdminFeedbackItem = v.object({
    _id: v.id("feedback"),
    createdAt: v.number(),
    // `url` is null when the object cannot be signed; the admin still sees that an image was attached.
    images: v.array(v.object({ contentType: v.string(), url: v.union(v.string(), v.null()) })),
    kind: vFeedbackKind,
    message: v.string(),
    pagePath: v.union(v.string(), v.null()),
    sender: vFeedbackSender,
});

/** Feedback from every user, newest first, a page at a time, optionally of one kind. */
export const listFeedback = adminQuery
    .input({
        cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
        kind: v.optional(vFeedbackKind),
        // Clamped in the handler, as the other admin lists do.
        limit: v.optional(v.number()),
    })
    .output(
        v.object({
            continueCursor: v.union(v.string(), v.null()),
            isDone: v.boolean(),
            page: v.array(vAdminFeedbackItem),
        }),
    )
    .query(async ({ args, ctx }) => {
        const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(args.limit ?? DEFAULT_PAGE_SIZE)));
        const result = await ctx.db.feedback.findMany({
            cursor: args.cursor ?? null,
            limit,
            orderBy: [{ createdAt: "desc" }],
            where: args.kind ? { kind: args.kind } : {},
        });

        const senderIds = [...new Set(result.page.map((row) => row.userId))];
        const { page: users } = senderIds.length === 0 ? { page: [] } : await ctx.db.user.findMany({ where: { _id: { in: senderIds as Id<"user">[] } } });
        const usersById = new Map(users.map((user) => [user._id as string, user]));
        const expiresInSeconds = displayUrlExpiresInSeconds();

        const page = await Promise.all(
            result.page.map(async (row) => {
                const user = usersById.get(row.userId);

                return {
                    _id: row._id,
                    createdAt: row.createdAt,
                    images: await Promise.all(
                        row.images.map(async (image) => {
                            return { contentType: image.contentType, url: await trySign(() => ctx.storage, image.key, expiresInSeconds) };
                        }),
                    ),
                    kind: row.kind,
                    message: row.message,
                    pagePath: row.pagePath ?? null,
                    sender: { email: user?.email ?? null, image: user?.image ?? null, name: user?.name ?? null, userId: row.userId },
                };
            }),
        );

        return { continueCursor: result.isDone ? null : (result.continueCursor ?? null), isDone: result.isDone, page };
    });
