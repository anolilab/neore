import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx as QueryContext } from "../../_generated/server";
import { authMutation, authQuery, rateLimit } from "../../lib/crpc";
import { withoutUndefined } from "../../lib/patch";
import { MAX_LENGTH } from "../../lib/validators";

/**
 * Presentations are owner-only. Every procedure here takes a presentation or
 * slide id from args, and there is no RLS behind it — this is the only check.
 * A stranger gets NOT_FOUND, the same answer as a missing id.
 */
const requireOwnedPresentation = async (
    context: Pick<QueryContext, "db">,
    presentationId: Id<"presentations">,
    userId: string,
): Promise<Doc<"presentations">> => {
    const presentation = await context.db.get(presentationId);

    if (!presentation || presentation.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Presentation not found");
    }

    return presentation;
};

const requireOwnedSlide = async (context: Pick<QueryContext, "db">, slideId: Id<"presentationSlides">, userId: string): Promise<Doc<"presentationSlides">> => {
    const slide = await context.db.get(slideId);

    if (!slide) {
        throw new LunoraError("NOT_FOUND", "Slide not found");
    }

    await requireOwnedPresentation(context, slide.presentationId, userId).catch(() => {
        throw new LunoraError("NOT_FOUND", "Slide not found");
    });

    return slide;
};
// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const getPresentation = authQuery
    .input({
        presentationId: v.id("presentations"),
    })
    .output(
        v.object({
            _creationTime: v.number(),
            _id: v.string(),
            createdAt: v.number(),
            description: v.optional(v.string()),
            lastCompletedSlide: v.optional(v.number()),
            name: v.string(),
            status: v.optional(v.string()),
            styleName: v.optional(v.string()),
            threadId: v.string(),
            title: v.string(),
            totalSlides: v.optional(v.number()),
            updatedAt: v.number(),
            userId: v.string(),
        }),
    )
    .query(
        async ({ args: { presentationId }, ctx: context }) =>
            await requireOwnedPresentation(context, presentationId as Id<"presentations">, context.user.userId),
    );

export const getThreadPresentations = authQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.string(),
                createdAt: v.number(),
                description: v.optional(v.string()),
                name: v.string(),
                status: v.optional(v.string()),
                styleName: v.optional(v.string()),
                threadId: v.string(),
                title: v.string(),
                totalSlides: v.optional(v.number()),
                updatedAt: v.number(),
                userId: v.string(),
            }),
        ),
    )
    .query(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;

        const presentations = await context.db
            .query("presentations")
            .withIndex("by_user_and_thread", (q) => q.eq("userId", userId).eq("threadId", threadId as Id<"threads">))
            .order("desc")
            .collect();

        return presentations;
    });

const vGetGeneratingPresentationOutput = v.union(
    v.object({
        _creationTime: v.number(),
        _id: v.string(),
        createdAt: v.number(),
        description: v.optional(v.string()),
        name: v.string(),
        status: v.optional(v.string()),
        styleName: v.optional(v.string()),
        threadId: v.string(),
        title: v.string(),
        totalSlides: v.optional(v.number()),
        updatedAt: v.number(),
        userId: v.string(),
    }),
    v.null(),
);

export const getGeneratingPresentation = authQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(v.from(vGetGeneratingPresentationOutput))
    .query(async ({ args: { threadId }, ctx: context }): Promise<Infer<typeof vGetGeneratingPresentationOutput>> => {
        const generating = await context.db
            .query("presentations")
            .withIndex("by_thread_and_status", (q) => q.eq("threadId", threadId as Id<"threads">).eq("status", "generating"))
            .order("desc")
            .first();

        return generating?.userId === context.user.userId ? generating : null;
    });

export const getPresentationSlides = authQuery
    .input({
        presentationId: v.id("presentations"),
    })
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.string(),
                createdAt: v.number(),
                htmlContent: v.string(),
                presentationId: v.string(),
                slideNumber: v.number(),
                title: v.string(),
                updatedAt: v.number(),
            }),
        ),
    )
    .query(async ({ args: { presentationId }, ctx: context }) => {
        await requireOwnedPresentation(context, presentationId as Id<"presentations">, context.user.userId);

        const slides = await context.db
            .query("presentationSlides")
            .withIndex("by_presentation_and_number", (q) => q.eq("presentationId", presentationId as Id<"presentations">))
            .collect();

        // Sort by slideNumber
        slides.sort((a, b) => a.slideNumber - b.slideNumber);

        return slides;
    });

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const createPresentation = authMutation
    .use(rateLimit("chat/update"))
    .input({
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        lastCompletedSlide: v.optional(v.number()),
        name: v.string().max(MAX_LENGTH.short),
        status: v.optional(v.string().max(MAX_LENGTH.short)),
        styleName: v.optional(v.string().max(MAX_LENGTH.short)),
        threadId: v.id("threads"),
        title: v.string().max(MAX_LENGTH.long),
        totalSlides: v.optional(v.number()),
    })
    .output(v.object({ presentationId: v.string() }))
    .mutation(async ({ args: { description, lastCompletedSlide, name, status, styleName, threadId, title, totalSlides }, ctx: context }) => {
        const { userId } = context.user;
        const thread = await context.db.get(threadId as Id<"threads">);

        if (!thread || thread.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Thread not found");
        }

        const now = context.now;
        const insertedId = await context.db.insert("presentations", {
            createdAt: now,
            description,
            lastCompletedSlide: lastCompletedSlide ?? 0,
            name: sanitizeName(name),
            status: status ?? "complete",
            styleName,
            threadId: threadId as Id<"threads">,
            title,
            totalSlides,
            updatedAt: now,
            userId,
        });

        context.log.event("chat.create_presentation", { hasStyle: styleName !== undefined, totalSlides: totalSlides ?? 0 });

        return { presentationId: insertedId as string };
    });

export const createSlide = authMutation
    .use(rateLimit("chat/update"))
    .input({
        htmlContent: v.string().max(MAX_LENGTH.document),
        presentationId: v.id("presentations"),
        slideNumber: v.number(),
        title: v.string().max(MAX_LENGTH.long),
    })
    .output(v.object({ slideId: v.string() }))
    .mutation(async ({ args: { htmlContent, presentationId, slideNumber, title }, ctx: context }) => {
        await requireOwnedPresentation(context, presentationId as Id<"presentations">, context.user.userId);

        const now = context.now;

        // Check if slide already exists (upsert semantics)
        const existing = await context.db
            .query("presentationSlides")
            .withIndex("by_presentation_and_number", (q) => q.eq("presentationId", presentationId as Id<"presentations">).eq("slideNumber", slideNumber))
            .first();

        let slideId: string;

        if (existing) {
            await context.db.patch(existing._id, {
                htmlContent,
                title,
                updatedAt: now,
            });
            slideId = existing._id as string;
        } else {
            const insertedId = await context.db.insert("presentationSlides", {
                createdAt: now,
                htmlContent,
                presentationId: presentationId as Id<"presentations">,
                slideNumber,
                title,
                updatedAt: now,
            });

            slideId = insertedId as string;
        }

        // Update presentation timestamp
        await context.db.patch(presentationId as Id<"presentations">, { updatedAt: now });

        context.log.event("chat.create_slide", { created: !existing });

        return { slideId };
    });

export const updateSlide = authMutation
    .use(rateLimit("chat/update"))
    .input({
        htmlContent: v.optional(v.string().max(MAX_LENGTH.document)),
        slideId: v.string().max(MAX_LENGTH.id),
        title: v.optional(v.string().max(MAX_LENGTH.long)),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { htmlContent, slideId, title }, ctx: context }) => {
        const slide = await requireOwnedSlide(context, slideId as Id<"presentationSlides">, context.user.userId);

        const now = context.now;
        const patch: { htmlContent?: string; title?: string; updatedAt: number } = { updatedAt: now };

        if (title !== undefined) {
            patch.title = title;
        }

        if (htmlContent !== undefined) {
            patch.htmlContent = htmlContent;
        }

        await context.db.patch(slideId as Id<"presentationSlides">, withoutUndefined(patch));

        // Update presentation timestamp
        await context.db.patch(slide.presentationId, { updatedAt: now });

        context.log.event("chat.update_slide", { htmlChanged: htmlContent !== undefined, titleChanged: title !== undefined });

        return { success: true };
    });

export const deleteSlide = authMutation
    .use(rateLimit("chat/update"))
    .input({
        slideId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { slideId }, ctx: context }) => {
        const slide = await requireOwnedSlide(context, slideId as Id<"presentationSlides">, context.user.userId);

        await context.db.delete(slideId as Id<"presentationSlides">);

        // Update presentation timestamp
        const now = context.now;

        await context.db.patch(slide.presentationId, { updatedAt: now });

        context.log.event("chat.delete_slide", { deleted: true });

        return { success: true };
    });

export const deletePresentation = authMutation
    .use(rateLimit("chat/update"))
    .input({
        presentationId: v.id("presentations"),
    })
    .output(v.object({ success: v.boolean() }))
    .mutation(async ({ args: { presentationId }, ctx: context }) => {
        await requireOwnedPresentation(context, presentationId as Id<"presentations">, context.user.userId);

        // Delete all slides
        const slides = await context.db
            .query("presentationSlides")
            .withIndex("by_presentation_and_number", (q) => q.eq("presentationId", presentationId as Id<"presentations">))
            .collect();

        for (const slide of slides) {
            await context.db.delete(slide._id);
        }

        // Delete presentation
        await context.db.delete(presentationId as Id<"presentations">);

        context.log.event("chat.delete_presentation", { slideCount: slides.length });

        return { success: true };
    });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sanitizeName = (name: string): string => name.replaceAll(/[^\w-]/g, "").toLowerCase();
