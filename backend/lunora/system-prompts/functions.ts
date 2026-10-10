/**
 * System-prompt preset CRUD.
 *
 * A user-owned library of named system prompts. Each preset can optionally be
 * scoped to a model id so the UI can surface relevant presets for the active
 * model in a thread.
 */
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";

const vPreset = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    createdAt: v.number(),
    description: v.union(v.string(), v.null()),
    modelId: v.union(v.string(), v.null()),
    name: v.string(),
    prompt: v.string(),
    updatedAt: v.number(),
});

/**
 * The stored row as the client sees it: `undefined` normalised to `null`.
 *
 * Typed against the Doc, not `Record<string, unknown>`. It was the latter, which
 * meant eight `as` casts doing no checking — and the call site could not even
 * reach them, because a generated `Doc_*` INTERFACE is not assignable to
 * `Record<string, unknown>` (no index signature). So the cast that was supposed
 * to make it work is what stopped it working.
 */
const presetRow = (row: Doc<"systemPromptPresets">) => {
    return {
        _creationTime: row._creationTime,
        _id: row._id as string,
        createdAt: row.createdAt,
        description: row.description ?? null,
        modelId: row.modelId ?? null,
        name: row.name,
        prompt: row.prompt,
        updatedAt: row.updatedAt,
    };
};

/** List all presets for the current user. */
export const listPresets = authQuery
    .input({
        modelId: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.from(v.array(vPreset)))
    .query(async ({ args: input, ctx: context }) => {
        const { userId } = context.user;
        const { modelId } = input;

        const rows = modelId
            ? await context.db
                  .query("systemPromptPresets")
                  .withIndex("by_userId_modelId", (q) => q.eq("userId", userId).eq("modelId", modelId))
                  .collect()
            : await context.db
                  .query("systemPromptPresets")
                  .withIndex("by_userId_modelId", (q) => q.eq("userId", userId))
                  .collect();

        return rows.map((row) => presetRow(row)).toSorted((a, b) => b.updatedAt - a.updatedAt);
    });

/** Create a new preset. */
export const createPreset = authMutation
    .use(rateLimit("prompts/create"))
    .input({
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        modelId: v.optional(v.string().max(MAX_LENGTH.short)),
        name: v.string().max(MAX_LENGTH.short),
        prompt: v.string().max(MAX_LENGTH.document),
    })
    .output(v.object({ presetId: v.string() }))
    .mutation(async ({ args: input, ctx: context }) => {
        const { userId } = context.user;
        const now = context.now;
        const inserted = await context.db.insert("systemPromptPresets", {
            createdAt: now,
            description: input.description,
            modelId: input.modelId,
            name: input.name,
            prompt: input.prompt,
            updatedAt: now,
            userId,
        });

        // `db.insert` returns the branded id STRING, not a row and not an array.
        // The `Array.isArray(...)` narrowing produced an `any` branch, which is the
        // only reason `.id` compiled — at runtime it reads `.id` off a string and
        // gets `undefined`.
        //
        // `createPreset` was returning `{ presetId: undefined }`.
        context.log.event("system_prompts.create_preset", { hasModel: input.modelId !== undefined, presetId: inserted });

        return { presetId: inserted };
    });

/** Update an existing preset. */
export const updatePreset = authMutation
    .use(rateLimit("prompts/update"))
    .input({
        description: v.optional(v.string().max(MAX_LENGTH.long)),
        modelId: v.optional(v.union(v.string().max(MAX_LENGTH.short), v.null())),
        name: v.optional(v.string().max(MAX_LENGTH.short)),
        presetId: v.string().max(MAX_LENGTH.id),
        prompt: v.optional(v.string().max(MAX_LENGTH.document)),
    })
    .output(v.object({ ok: v.literal(true) }))
    .mutation(async ({ args: input, ctx: context }) => {
        const { userId } = context.user;

        const existing = await context.db.get(input.presetId as Id<"systemPromptPresets">);

        if (!existing || (existing as { userId: string }).userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Preset not found");
        }

        const patch: Partial<Doc<"systemPromptPresets">> = { updatedAt: context.now };

        if (input.name !== undefined) patch.name = input.name;

        if (input.description !== undefined) patch.description = input.description;

        if (input.prompt !== undefined) patch.prompt = input.prompt;

        // `modelId: null` means "any model": `undefined` makes `patchRow` remove it.
        if (input.modelId !== undefined) patch.modelId = input.modelId ?? undefined;

        await patchRow(context.db, existing, patch);

        context.log.event("system_prompts.update_preset", { presetId: input.presetId, updatedFieldCount: Object.keys(patch).length - 1 });

        return { ok: true as const };
    });

/** Delete a preset. */
export const deletePreset = authMutation
    .use(rateLimit("prompts/delete"))
    .input({
        presetId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ ok: v.literal(true) }))
    .mutation(async ({ args: input, ctx: context }) => {
        const { userId } = context.user;

        const existing = await context.db.get(input.presetId as Id<"systemPromptPresets">);

        if (!existing || (existing as { userId: string }).userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Preset not found");
        }

        await context.db.delete(input.presetId as Id<"systemPromptPresets">);

        context.log.event("system_prompts.delete_preset", { presetId: input.presetId });

        return { ok: true as const };
    });
