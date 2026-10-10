import type { Infer } from "lunorash/server";
import { displayUrlForFile, withDisplayUrls } from "./lib/display-url";
import { v } from "lunorash/server";
import { LunoraError } from "lunorash/server";

import { api } from "../_generated/api";
import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx as MutationContext, type QueryCtx as QueryContext } from "../_generated/server";
import { meetsThreadPermission, resolveThreadReadAccess } from "../agent/thread-read-access";
import { assertOwnOrganizationId } from "../auth/lib/organization-helpers";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { ERROR_CODES, getErrorMessage } from "../lib/error-codes";
import { throwBadRequest, throwForbidden, throwUnauthorized } from "../lib/error-helpers";
import { takeStagedUpload } from "../lib/chat-upload";
import { r2 } from "../lib/r2";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";
import { MAX_FILE_SIZE, UPLOAD_ALLOWED_MIME } from "./lib/file-constants";
import sanitizeAndValidateFileName from "./lib/filename";
import { patchRow, withoutUndefined } from "../lib/patch";
import { systemDb } from "../lib/rls/scope";
import { MAX_LENGTH } from "../lib/validators";
import { withDependency } from "../lib/dependency";

// R2 client and client API exports (used by React upload hook and server routes)

type AllowedMimeType = (typeof UPLOAD_ALLOWED_MIME)[number];

type SavedAttachment = {
    _creationTime: number;
    _id: Id<"files">;
    chatId?: string;
    fileName: string; // display name
    fileSize: number;
    fileType: string;
    key?: string; // R2 object key
    url?: string;
    userId: string;
};

/**
 * The chat a file may be attached to: the owner's, or one the caller holds a
 * live `write`/`admin` grant on. `null` otherwise — organization membership is
 * not a thread grant (see `agent/thread-read-access.ts`).
 */
const getWritableChat = async (context: Pick<MutationContext, "db">, chatId: string, userId: string) => {
    const access = await resolveThreadReadAccess(context, chatId as Id<"threads">, userId);

    return access?.kind === "full" && meetsThreadPermission(access.permission, "write") ? access.thread : null;
};

/**
 * Who may read a vault file: its OWNER, or someone the owner shared its chat with
 * (a live thread grant). Organization membership grants nothing by itself — the
 * same rule threads follow (`agent/thread-read-access.ts`); a file's
 * `organizationId` records where it was uploaded, not who may see it.
 */
const hasFileAccess = async (context: Pick<QueryContext, "db">, file: { chatId?: string; userId: string }, userId: string): Promise<boolean> => {
    if (file.userId === userId) {
        return true;
    }

    if (!file.chatId) {
        return false;
    }

    const access = await resolveThreadReadAccess(context, file.chatId as Id<"threads">, userId);

    return access?.kind === "full";
};

/**
 * Copy an uploaded object's real content type and size onto its row.
 *
 * An action, because `getMetadata` reads R2. The write is delegated to
 * `applyFileMetadata` so the row update stays transactional.
 */
export const syncMetadata = authAction
    .use(rateLimit("vault/upload"))
    .input({ key: v.string().max(MAX_LENGTH.key) })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const meta = await r2.getMetadata(ctx, args.key);

        await ctx.runMutation(internal.vault.functions.applyFileMetadata, {
            key: args.key,
            size: meta?.size ?? 0,
            type: meta?.contentType ?? "application/octet-stream",
            userId: ctx.user.userId,
        });

        ctx.log.event("vault.sync_metadata", { size: meta?.size ?? 0 });

        return null;
    });

export const applyFileMetadata = internalMutation
    .input({ key: v.string(), size: v.number(), type: v.string(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db
            .query("files")
            .withIndex("by_key", (q) => q.eq("key", args.key))
            .first();

        // Only the uploader's own row: the key arrives from a client.
        if (row && row.userId === args.userId) {
            await ctx.db.patch(row._id as Id<"files">, { size: args.size, type: args.type });
        }

        return null;
    });

/**
 * Saves a generated image to the attachments table with isGenerated flag
 */
export const saveGeneratedImage = authAction
    .use(rateLimit("vault/upload"))
    .input({
        chatId: v.string().max(MAX_LENGTH.id),
        fileName: v.optional(v.string().max(MAX_LENGTH.short)),
        key: v.string().max(MAX_LENGTH.key),
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        url: v.optional(v.string().max(MAX_LENGTH.document)),
    })
    .output(
        // Was `z.looseObject`, whose extra-key passthrough was the only thing
        // carrying `userId` — present on the returned `SavedAttachment` but absent
        // from the schema. Spelled out instead of relying on looseness.
        v.object({
            _creationTime: v.number(),
            _id: v.string(),
            chatId: v.optional(v.string()),
            fileName: v.string(),
            fileSize: v.number(),
            fileType: v.string(),
            key: v.optional(v.string()),
            organizationId: v.optional(v.string()),
            url: v.optional(v.string()),
            userId: v.string(),
        }),
    )
    .action(async ({ args, ctx }): Promise<SavedAttachment> => {
        const { userId } = ctx.user;

        // Sync metadata and read it
        await ctx.runAction(api.vault.functions.syncMetadata, { key: args.key });
        const meta = await r2.getMetadata(ctx, args.key);
        const mime = meta?.contentType ?? "application/octet-stream";
        const size = meta?.size ?? 0;

        // The same allow-list and cap every other attachment path enforces.
        if (!UPLOAD_ALLOWED_MIME.includes(mime as AllowedMimeType)) {
            throwBadRequest(getErrorMessage(ERROR_CODES.UNSUPPORTED_FILE_TYPE));
        }

        if (size > MAX_FILE_SIZE) {
            throwBadRequest(getErrorMessage(ERROR_CODES.FILE_TOO_LARGE));
        }

        // Compute default filename if not provided
        const epochMs = Date.now();
        const subtype = mime.split("/", 2)[1] ?? "";
        const defaultExtension = (subtype.split("+", 1)[0] || "bin").toLowerCase();
        const fileName = args.fileName ?? `gen-${epochMs}.${defaultExtension}`;

        const attachmentId = await ctx.runMutation(internal.vault.functions.internalSaveGenerated, {
            chatId: args.chatId,
            fileName,
            fileSize: size,
            fileType: mime,
            key: args.key,
            // No URL is stored — the key is, and reads sign it (`lib/display-url.ts`).
            userId,
        });
        const attachment = await ctx.runQuery(api.vault.functions.getAttachment, {
            attachmentId,
        });

        if (!attachment) {
            throw new LunoraError("NOT_FOUND", "Generated image not found");
        }

        ctx.log.event("vault.save_generated_image", { hasFileName: args.fileName !== undefined });

        return { ...attachment };
    });

export const markNsfwChecking = internalMutation
    .input({
        fileId: v.id("files"),
    })
    .output(v.null())
    .mutation(async ({ args: arguments_, ctx: context }) => {
        const file = await context.db.get(arguments_.fileId as Id<"files">);

        if (!file) {
            return null;
        }

        await context.db.patch(arguments_.fileId, {
            nsfwStatus: "checking",
        });

        return null;
    });

export const saveNsfwResult = internalMutation
    .input({
        fileId: v.id("files"),
        isNsfw: v.boolean(),
        scores: v.any(),
    })
    .output(v.null())
    .mutation(async ({ args: arguments_, ctx: context }) => {
        const file = await context.db.get(arguments_.fileId as Id<"files">);

        if (!file) {
            return null;
        }

        // `v.any()` arguments can arrive undefined, which a patch refuses.
        await context.db.patch(arguments_.fileId, {
            ...withoutUndefined({ nsfwScores: arguments_.scores }),
            nsfwStatus: arguments_.isNsfw ? "blocked" : "safe",
        });

        return null;
    });

export const markNsfwFailed = internalMutation
    .input({
        fileId: v.id("files"),
    })
    .output(v.null())
    .mutation(async ({ args: arguments_, ctx: context }) => {
        const file = await context.db.get(arguments_.fileId as Id<"files">);

        if (!file) {
            return null;
        }

        await context.db.patch(arguments_.fileId, {
            nsfwStatus: "failed",
        });

        return null;
    });

export const internalSaveGenerated = internalMutation
    .input({
        chatId: v.string(),
        fileName: v.string(),
        fileSize: v.number(),
        fileType: v.string(),
        key: v.string(),
        url: v.optional(v.string()),
        userId: v.string(),
    })
    .output(v.id("files"))
    .mutation(async ({ args: arguments_, ctx: context }) => {
        const { userId } = arguments_;

        if (!userId) {
            throwUnauthorized(getErrorMessage(ERROR_CODES.NOT_AUTHENTICATED));
        }

        // Verify ownership of the key to this user
        const existing = await context.db
            .query("files")
            .withIndex("by_key", (q) => q.eq("key", arguments_.key))
            .first();

        if (!existing || existing.userId !== userId) {
            throwForbidden(getErrorMessage(ERROR_CODES.UNAUTHORIZED));
        }

        // Attaching to a chat is a write: the owner, or a grantee with write
        // access. Organization membership grants nothing on a thread.
        const chat = await getWritableChat(context, arguments_.chatId, userId);

        if (!chat) {
            await scheduleObjectDeletion(context, [arguments_.key]);
            throwForbidden(getErrorMessage(ERROR_CODES.UNAUTHORIZED));
        }

        // Generated images don't need model validation since they're created by our system
        // Also don't need MIME type validation since we control the generation

        // Validate R2 object key is non-empty
        if (!arguments_.key || arguments_.key.trim().length === 0) {
            throwBadRequest(getErrorMessage(ERROR_CODES.INVALID_INPUT));
        }

        const safeName = sanitizeAndValidateFileName(arguments_.fileName);

        await patchRow(context.db, existing, {
            chatId: arguments_.chatId,
            isGenerated: true,
            name: safeName,
            // The chat's organization, never a client-supplied one.
            organizationId: chat.organizationId,
            size: arguments_.fileSize,
            type: arguments_.fileType,
            url: arguments_.url,
        });

        if (arguments_.fileType.startsWith("image/")) {
            await context.scheduler.runAfter(0, internal.agent.nsfw_check.checkImageNsfwForVaultFile, {
                fileId: existing._id,
                mediaType: arguments_.fileType,
                r2Key: arguments_.key,
            });
        }

        return existing._id;
    });

// Native validators, not `v.from(zod)`: codegen cannot read through the zod
// wrapper, so the generated reference returned `unknown` (see the same note on
// `findAttachmentByKey`). The handler spreads the whole `files` row and then
// aliases three columns, so the full row is declared here rather than the
// `.passthrough()` the zod version relied on — otherwise the declared shape and
// the runtime payload disagree.
const vAttachmentRowFields = {
    _creationTime: v.number(),
    _id: v.id("files"),
    chatId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    folderId: v.optional(v.id("folders")),
    isGenerated: v.optional(v.boolean()),
    key: v.optional(v.string()),
    name: v.string(),
    nsfwScores: v.optional(v.object({ drawing: v.number(), hentai: v.number(), neutral: v.number(), porn: v.number(), sexy: v.number() })),
    nsfwStatus: v.optional(v.union(v.literal("pending"), v.literal("checking"), v.literal("safe"), v.literal("blocked"), v.literal("failed"))),
    organizationId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    size: v.number(),
    tags: v.optional(v.array(v.string())),
    thumbnailStorageId: v.optional(v.string()),
    totalChunks: v.optional(v.number()),
    type: v.string(),
    updatedAt: v.optional(v.number()),
    url: v.optional(v.string()),
    userId: v.string(),
};

// The `file*` aliases the vault UI consumes, layered over the raw row.
const vAttachmentFields = {
    ...vAttachmentRowFields,
    fileName: v.string(),
    fileSize: v.number(),
    fileType: v.string(),
};

const vGetAttachmentOutput = v.object(vAttachmentFields);

export const getAttachment = authQuery
    .input({
        attachmentId: v.id("files"),
    })
    .output(v.from(vGetAttachmentOutput))
    .query(async ({ args: { attachmentId }, ctx }): Promise<Infer<typeof vGetAttachmentOutput>> => {
        const { userId } = ctx.user;

        // Looked up past row-level security and returned only if `hasFileAccess`
        // passes: a chat grantee's file is not visible until its chat is admitted.
        const attachment = await systemDb(ctx).get(attachmentId as Id<"files">);

        if (!attachment || !(await hasFileAccess(ctx, attachment, userId))) {
            throw new LunoraError("FORBIDDEN", "Not authorized to access this file");
        }

        // Map the unified fields to the expected attachment format
        return {
            ...attachment,
            fileName: attachment.name,
            fileSize: attachment.size,
            fileType: attachment.type,
            url: await displayUrlForFile(() => ctx.storage, attachment),
        };
    });

// Helper query to find a pending/partial attachment by key
export const findAttachmentByKey = authQuery
    .input({
        key: v.string().max(MAX_LENGTH.key),
    })
    // Native validators, not `v.from(zod)`: codegen cannot read through the zod
    // wrapper, so the generated reference returned `{}` and the caller's
    // `row.userId` — the authorization check — did not type-check.
    //
    // `.passthrough()` is dropped deliberately. It let the whole `files` row
    // through undeclared, which is how `url` and `key` ended up optional here
    // while being required on the row. The three renamed fields are what the
    // attachment shape is FOR; the rest of the row travelled by accident.
    .output(
        v.union(
            v.null(),
            v.object({
                _creationTime: v.number(),
                _id: v.string(),
                chatId: v.optional(v.string()),
                fileName: v.string(),
                fileSize: v.number(),
                fileType: v.string(),
                key: v.optional(v.string()),
                name: v.string(),
                organizationId: v.optional(v.string()),
                size: v.number(),
                type: v.string(),
                url: v.optional(v.string()),
                userId: v.string(),
            }),
        ),
    )
    .query(async ({ args: { key }, ctx }) => {
        const { userId } = ctx.user;

        // Decided like `getAttachment`: looked up past row-level security, returned only on access.
        const row = await systemDb(ctx)
            .query("files")
            .withIndex("by_key", (q) => q.eq("key", key))
            .first();

        if (!row || !(await hasFileAccess(ctx, row, userId))) {
            return null;
        }

        // Map the unified fields to the expected attachment format
        return {
            _creationTime: row._creationTime,
            _id: row._id,
            chatId: row.chatId,
            fileName: row.name,
            fileSize: row.size,
            fileType: row.type,
            key: row.key,
            name: row.name,
            organizationId: row.organizationId,
            size: row.size,
            type: row.type,
            url: await displayUrlForFile(() => ctx.storage, row),
            userId: row.userId,
        };
    });

/**
 * Generates a fresh URL for a storage ID
 */
export const getStorageUrl = authQuery
    .input({
        key: v.string().max(MAX_LENGTH.key),
    })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { key }, ctx }) => {
        const { userId } = ctx.user;

        // Verify the user has access to this file before generating URL
        const file = await systemDb(ctx)
            .query("files")
            .withIndex("by_key", (q) => q.eq("key", key))
            .first();

        if (!file || !(await hasFileAccess(ctx, file, userId))) {
            throw new LunoraError("FORBIDDEN", "Not authorized to access this file");
        }

        // A signed URL with a query-stable expiry; there is no public bucket.
        return (await displayUrlForFile(() => ctx.storage, { key })) ?? null;
    });

/**
 * A short-lived signed URL for downloading one vault file.
 *
 * An ACTION, not a query: a signed URL expires, so it must never sit in a
 * reactive query cache. Ownership goes through `getAttachment`, which throws
 * FORBIDDEN unless the caller owns the file or holds a grant on its chat — so
 * this signs nothing the caller could not already read.
 */
export const getDownloadUrl = authAction
    .use(rateLimit("vault/download"))
    .input({ attachmentId: v.id("files") })
    .output(v.object({ fileName: v.string(), url: v.string() }))
    .action(async ({ args, ctx }) => {
        const attachment = await ctx.runQuery(api.vault.functions.getAttachment, { attachmentId: args.attachmentId });

        if (!attachment.key) {
            throw new LunoraError("NOT_FOUND", "File has no stored object");
        }

        const key = attachment.key;

        const url = await withDependency("file storage", () => ctx.storage.getSignedUrl(key, { expiresInSeconds: 300 }));

        ctx.log.event("vault.get_download_url", { expiresInSeconds: 300 });

        return { fileName: attachment.fileName, url };
    });

/**
 * Fetches the caller's own chat attachments.
 *
 * Shares `vAttachmentFields` (the whole `files` row plus the three UI aliases)
 * with `getAttachment` — the handler spreads the row, and `v.object` STRIPS
 * undeclared keys on the way out, so every column has to be declared or it
 * silently disappears from the response.
 */
export const getAttachmentsForUser = authQuery.output(v.from(v.array(v.object(vAttachmentFields)))).query(async ({ ctx }) => {
    const { userId } = ctx.user;

    // Limit to most recent 500 attachments to prevent timeout
    const MAX_ATTACHMENTS = 500;

    // The caller's OWN uploads only. This used to merge in every file tagged with
    // the active organization — other members' chat attachments included.
    const personalFiles = await ctx.db
        .query("files")
        .withIndex("by_user_and_folder", (q) => q.eq("userId", userId))
        .order("desc")
        .take(MAX_ATTACHMENTS);

    // Chat attachments (chatId defined), most recent first
    const uniqueAttachments = personalFiles.filter((f) => f.chatId !== undefined).toSorted((a, b) => b._creationTime - a._creationTime);

    const displayRows = await withDisplayUrls(() => ctx.storage, uniqueAttachments);

    return displayRows.map((attachment) => {
        return {
            ...attachment,
            fileName: attachment.name,
            fileSize: attachment.size,
            fileType: attachment.type,
        };
    });
});

export const deleteAttachments = authMutation
    .use(rateLimit("vault/delete"))
    .input({
        attachmentIds: v.array(v.string().max(MAX_LENGTH.id)),
    })
    .mutation(async ({ args: { attachmentIds }, ctx }) => {
        const { userId } = ctx.user;

        // Create a Set for O(1) lookup of attachment IDs to delete
        const attachmentIdsToDelete = new Set(attachmentIds);

        // Limit to most recent files to prevent timeout
        const MAX_FILES = 2000;

        // Deleting is the UPLOADER's alone, so only the caller's own files are
        // candidates. Org membership grants nothing on another member's file; it
        // used to let them delete other members' uploads.
        const personalFiles = await ctx.db
            .query("files")
            .withIndex("by_user_and_folder", (q) => q.eq("userId", userId))
            .take(MAX_FILES);

        // Chat attachments (chatId defined) that are in the deletion list
        const validAttachments = personalFiles.filter((attachment) => attachment.chatId !== undefined && attachmentIdsToDelete.has(attachment._id));

        // Delete files from storage and database records in parallel
        const keysToDelete = validAttachments.map((a) => a.key).filter((key): key is string => key !== undefined);
        const idsToDelete = validAttachments.map((a) => a._id);

        await Promise.all([...keysToDelete.map((key) => scheduleObjectDeletion(ctx, [key])), ...idsToDelete.map((id) => ctx.db.delete(id))]);

        ctx.log.event("vault.delete_attachments", { deleted: idsToDelete.length, requested: attachmentIds.length });
    });

/**
 * The caller's own attachments uploaded within their active organization.
 * Membership grants no view of other members' files (see `hasFileAccess`).
 */
export const getAttachmentsForOrganization = authQuery.output(v.from(v.array(v.object(vAttachmentFields)))).query(async ({ ctx }) => {
    const organizationId = ctx.user.activeOrganization?.id;

    if (!organizationId) {
        throw new LunoraError("FORBIDDEN", "No organization selected");
    }

    // Limit to most recent 500 attachments to prevent timeout
    const MAX_ATTACHMENTS = 500;

    // Get organization files, then filter for chat attachments in code
    const allOrgFiles = await ctx.db
        .query("files")
        .withIndex("by_organization_and_chatId", (q) => q.eq("organizationId", organizationId))
        .order("desc")
        .take(MAX_ATTACHMENTS);
    const attachments = allOrgFiles.filter((f) => f.chatId !== undefined && f.userId === ctx.user.userId);

    const displayRows = await withDisplayUrls(() => ctx.storage, attachments);

    return displayRows.map((attachment) => {
        return {
            ...attachment,
            fileName: attachment.name,
            fileSize: attachment.size,
            fileType: attachment.type,
        };
    });
});

// Same rows as `getAttachment`, so it reuses the same field set. The zod version
// declared a subset and leaned on `.passthrough()`; the handler actually spreads
// the whole row, which is what is declared here.
const vGetAttachmentsForChatOutput = v.array(v.object(vAttachmentFields));

export const getAttachmentsForChat = authQuery
    .input({
        chatId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.from(vGetAttachmentsForChatOutput))
    .query(async ({ args: { chatId }, ctx }): Promise<Infer<typeof vGetAttachmentsForChatOutput>> => {
        // Owner or live grantee only: attachments are raw rows (URLs, keys), so a
        // public thread's redacted view and organization membership grant nothing.
        const access = await resolveThreadReadAccess(ctx, chatId as Id<"threads">, ctx.user.userId);

        if (access?.kind !== "full") {
            throw new LunoraError("FORBIDDEN", "Not authorized to access this chat");
        }

        // Limit to most recent 100 attachments per chat to prevent timeout
        const MAX_CHAT_ATTACHMENTS = 100;

        const attachments = await ctx.db
            .query("files")
            .withIndex("by_chatId", (q) => q.eq("chatId", chatId))
            .order("desc")
            .take(MAX_CHAT_ATTACHMENTS);

        const displayRows = await withDisplayUrls(() => ctx.storage, attachments);

        return displayRows.map((attachment) => {
            return {
                ...attachment,
                fileName: attachment.name,
                fileSize: attachment.size,
                fileType: attachment.type,
            };
        });
    });

/**
 * Take an uploaded file into the vault (and, through `knowledge.addFile`, the
 * knowledge base).
 *
 * The browser — or a public API client — sent the bytes over TUS to the upload
 * route (`lib/upload-route.ts`), which staged them under the caller's own
 * prefix. Only the `uploadId` comes from the caller: the staging key is rebuilt
 * from the caller's identity, and what arrived is checked — the vault's size
 * cap, the MIME allowlist, the leading bytes — before it moves to its own key
 * (`takeStagedUpload`). The row records the stored object's real size and
 * type, which are returned for the caller to pass on.
 */
export const saveVaultFile = authAction
    .use(rateLimit("vault/upload"))
    .input({
        fileName: v.string().max(MAX_LENGTH.short),
        organizationId: v.optional(v.string().max(MAX_LENGTH.id)),
        uploadId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ fileId: v.id("files"), fileSize: v.number(), fileType: v.string() }))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        // Tagging a file with an org shows it to that org's members: only the
        // caller's own active organization.
        assertOwnOrganizationId(ctx.user, args.organizationId);

        const organizationId = args.organizationId || ctx.user.activeOrganization?.id;
        const name = sanitizeAndValidateFileName(args.fileName);

        const saved = await takeStagedUpload(
            ctx,
            userId,
            args.uploadId,
            () => MAX_FILE_SIZE,
            async ({ bytes, contentType }) => {
                const key = crypto.randomUUID();

                await withDependency("file storage", () =>
                    ctx.storage.store(key, bytes, { allowedContentTypes: UPLOAD_ALLOWED_MIME, contentType, maxSize: MAX_FILE_SIZE }),
                );

                try {
                    const fileId = await ctx.runMutation(internal.vault.functions.insertVaultFile, {
                        key,
                        name,
                        organizationId,
                        size: bytes.byteLength,
                        type: contentType,
                        userId,
                    });

                    return { fileId, fileSize: bytes.byteLength, fileType: contentType };
                } catch (error) {
                    // No row, no reference: the object would be unreachable.
                    await ctx.storage.delete(key).catch(() => undefined);

                    throw error;
                }
            },
        );

        ctx.log.event("vault.save_vault_file", { fileSize: saved.fileSize, fileType: saved.fileType, hasOrganization: organizationId !== undefined });

        return saved;
    });

/** The row of a file {@link saveVaultFile} just stored. */
export const insertVaultFile = internalMutation
    .input({ key: v.string(), name: v.string(), organizationId: v.optional(v.string()), size: v.number(), type: v.string(), userId: v.string() })
    .output(v.id("files"))
    .mutation(async ({ args, ctx }) => await ctx.db.insert("files", withoutUndefined(args)));
