/**
 * Internal slide mutations for use by AI tools (action context).
 *
 * Public cRPC functions in functions.ts require session auth headers,
 * so tools running in an action context use these internal mutations
 * where the userId is passed explicitly.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../_generated/server";
import { withoutUndefined } from "../../lib/patch";

export const createPresentation = internalMutation
    .input({
        description: v.optional(v.string()),
        lastCompletedSlide: v.optional(v.number()),
        name: v.string(),
        status: v.optional(v.string()),
        styleName: v.optional(v.string()),
        threadId: v.id("threads"),
        title: v.string(),
        totalSlides: v.optional(v.number()),
        userId: v.string(),
    })
    .output(v.object({ presentationId: v.id("presentations") }))
    .mutation(async ({ args, ctx }) => {
        const now = ctx.now;
        const insertedId = await ctx.db.insert("presentations", {
            createdAt: now,
            description: args.description,
            lastCompletedSlide: args.lastCompletedSlide ?? 0,
            name: sanitizeName(args.name),
            status: args.status ?? "complete",
            styleName: args.styleName,
            threadId: args.threadId,
            title: args.title,
            totalSlides: args.totalSlides,
            updatedAt: now,
            userId: args.userId,
        });

        return { presentationId: insertedId as Id<"presentations"> };
    });

export const updatePresentationStatus = internalMutation
    .input({
        presentationId: v.id("presentations"),
        status: v.string(),
    })
    .mutation(async ({ args, ctx }) => {
        await ctx.db.patch(args.presentationId, {
            status: args.status,
            updatedAt: ctx.now,
        });
    });

export const createSlide = internalMutation
    .input({
        htmlContent: v.string(),
        presentationId: v.id("presentations"),
        slideNumber: v.number(),
        title: v.string(),
    })
    .output(v.object({ slideId: v.id("presentationSlides") }))
    .mutation(async ({ args, ctx }) => {
        const now = ctx.now;

        // Upsert: check if slide with same number already exists
        const existing = await ctx.db
            .query("presentationSlides")
            .withIndex("by_presentation_and_number", (q) => q.eq("presentationId", args.presentationId).eq("slideNumber", args.slideNumber))
            .first();
        let slideId: Id<"presentationSlides">;

        if (existing) {
            await ctx.db.patch(existing._id, {
                htmlContent: args.htmlContent,
                title: args.title,
                updatedAt: now,
            });
            slideId = existing._id;
        } else {
            const insertedId = await ctx.db.insert("presentationSlides", {
                createdAt: now,
                htmlContent: args.htmlContent,
                presentationId: args.presentationId,
                slideNumber: args.slideNumber,
                title: args.title,
                updatedAt: now,
            });

            slideId = insertedId as Id<"presentationSlides">;
        }

        // Update presentation timestamp and lastCompletedSlide
        const presentation = await ctx.db.get(args.presentationId);
        const currentLast = presentation?.lastCompletedSlide ?? 0;

        await ctx.db.patch(args.presentationId, {
            lastCompletedSlide: Math.max(currentLast, args.slideNumber),
            updatedAt: now,
        });

        return { slideId };
    });

export const getResumablePresentation = internalQuery
    .input({
        threadId: v.id("threads"),
        title: v.string(),
    })
    .query(async ({ args, ctx }) => {
        // Look for generating or error presentations with the same title
        const generating = await ctx.db
            .query("presentations")
            .withIndex("by_thread_and_status", (q) => q.eq("threadId", args.threadId).eq("status", "generating"))
            .order("desc")
            .first();

        if (generating && generating.title === args.title) {
            return generating;
        }

        const errored = await ctx.db
            .query("presentations")
            .withIndex("by_thread_and_status", (q) => q.eq("threadId", args.threadId).eq("status", "error"))
            .order("desc")
            .first();

        if (errored && errored.title === args.title) {
            return errored;
        }

        return null;
    });

export const updateSlide = internalMutation
    .input({
        htmlContent: v.optional(v.string()),
        presentationId: v.id("presentations"),
        slideNumber: v.number(),
        threadId: v.id("threads"),
        title: v.optional(v.string()),
        userId: v.string(),
    })
    .output(v.object({ slideId: v.id("presentationSlides") }))
    .mutation(async ({ args, ctx }) => {
        const presentation = await ctx.db.get(args.presentationId);

        if (!presentation) {
            throw new LunoraError("NOT_FOUND", `Presentation ${args.presentationId} not found`);
        }

        if (presentation.userId !== args.userId) {
            throw new LunoraError("FORBIDDEN", "Cannot update slide: not the owner");
        }

        if (presentation.threadId && presentation.threadId !== args.threadId) {
            throw new LunoraError("FORBIDDEN", "Cannot update slide: belongs to a different thread");
        }

        const existing = await ctx.db
            .query("presentationSlides")
            .withIndex("by_presentation_and_number", (q) => q.eq("presentationId", args.presentationId).eq("slideNumber", args.slideNumber))
            .first();

        if (!existing) {
            throw new LunoraError("NOT_FOUND", `Slide ${args.slideNumber} not found in presentation`);
        }

        const now = ctx.now;
        const patch: { htmlContent?: string; title?: string; updatedAt: number } = { updatedAt: now };

        if (args.title !== undefined) {
            patch.title = args.title;
        }

        if (args.htmlContent !== undefined) {
            patch.htmlContent = args.htmlContent;
        }

        await ctx.db.patch(existing._id, withoutUndefined(patch));
        await ctx.db.patch(args.presentationId, { updatedAt: now });

        return { slideId: existing._id };
    });

const sanitizeName = (name: string): string => name.replaceAll(/[^\w-]/g, "").toLowerCase();
