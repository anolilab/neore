/**
 * R2 Workspace Sync for Sandbox
 *
 * Syncs files between Cloudflare R2 storage and E2B sandbox filesystem.
 * Enables persistent workspaces: users can save their sandbox workspace
 * to R2 and restore it in a new sandbox session.
 *
 * Features:
 * - Save workspace: tar + gzip sandbox directory → upload to R2
 * - Restore workspace: download from R2 → extract into sandbox
 * - Per-user workspace storage keyed by thread or project
 * - Automatic workspace snapshot on session close
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { E2B_API_KEY, R2_ACCESS_KEY_ID, R2_BUCKET, R2_ENDPOINT, R2_SECRET_ACCESS_KEY } from "../env";

("use node");

const WORKSPACE_DIR = "/home/user";
const MAX_WORKSPACE_SIZE = 100 * 1024 * 1024; // 100MB max workspace archive
const WORKSPACE_PREFIX = "sandbox-workspaces";

// `getWorkspaceMetadata` lives in workspaceSyncFunctions.ts (V8 runtime).

export const saveWorkspace = internalAction
    .input({
        sandboxId: v.string(),
        sessionId: v.id("sandboxSessions"),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .action(async ({ args: { sandboxId, sessionId, threadId, userId }, ctx }) => {
        if (!E2B_API_KEY || !R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
            return { error: "R2 or E2B not configured", success: false };
        }

        try {
            const { Sandbox } = await import("e2b");
            const sandbox = await Sandbox.connect(sandboxId, {
                apiKey: E2B_API_KEY,
            });

            // Create tar.gz of the workspace
            const archivePath = "/tmp/workspace.tar.gz";
            const tarResult = await sandbox.commands.run(
                `cd ${WORKSPACE_DIR} && tar czf ${archivePath} --exclude='.cache' --exclude='node_modules' --exclude='.npm' --exclude='__pycache__' . 2>/dev/null; stat -c%s ${archivePath}`,
                { timeoutMs: 60_000 },
            );

            if (tarResult.exitCode !== 0) {
                return { error: `Tar failed: ${tarResult.stderr}`, success: false };
            }

            const archiveSize = parseInt(tarResult.stdout.trim(), 10);

            if (Number.isNaN(archiveSize) || archiveSize > MAX_WORKSPACE_SIZE) {
                return {
                    error: `Workspace too large: ${archiveSize} bytes (max ${MAX_WORKSPACE_SIZE})`,
                    success: false,
                };
            }

            // Read the archive
            const archiveContent = await sandbox.files.read(archivePath);

            // Upload to R2 via S3-compatible API
            const r2Key = `${WORKSPACE_PREFIX}/${userId}/${threadId}/${Date.now()}.tar.gz`;

            const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");

            const s3 = new S3Client({
                credentials: {
                    accessKeyId: R2_ACCESS_KEY_ID,
                    secretAccessKey: R2_SECRET_ACCESS_KEY,
                },
                endpoint: R2_ENDPOINT,
                region: "auto",
            });

            const body = typeof archiveContent === "string" ? Buffer.from(archiveContent, "binary") : Buffer.from(archiveContent as ArrayBuffer);

            await s3.send(
                new PutObjectCommand({
                    Body: body,
                    Bucket: R2_BUCKET,
                    ContentType: "application/gzip",
                    Key: r2Key,
                }),
            );

            // Store the R2 key in the session record (reusing cleanupFnId with a prefix)
            await ctx.runMutation(internal.sandbox.functions.updateSession, {
                cleanupFnId: `workspace:${r2Key}`,
                sessionId,
            });

            return { r2Key, size: archiveSize, success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            return { error: errorMessage, success: false };
        }
    });

export const restoreWorkspace = internalAction
    .input({
        r2Key: v.string(),
        sandboxId: v.string(),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .action(async ({ args: { r2Key, sandboxId }, ctx: _context }) => {
        if (!E2B_API_KEY || !R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
            return { error: "R2 or E2B not configured", success: false };
        }

        try {
            // Download from R2
            const { GetObjectCommand, S3Client } = await import("@aws-sdk/client-s3");

            const s3 = new S3Client({
                credentials: {
                    accessKeyId: R2_ACCESS_KEY_ID,
                    secretAccessKey: R2_SECRET_ACCESS_KEY,
                },
                endpoint: R2_ENDPOINT,
                region: "auto",
            });

            const response = await s3.send(
                new GetObjectCommand({
                    Bucket: R2_BUCKET,
                    Key: r2Key,
                }),
            );

            if (!response.Body) {
                return { error: "Empty workspace archive", success: false };
            }

            const bodyBytes = await response.Body.transformToByteArray();

            // Connect to sandbox and upload the archive
            const { Sandbox } = await import("e2b");
            const sandbox = await Sandbox.connect(sandboxId, {
                apiKey: E2B_API_KEY,
            });

            const archivePath = "/tmp/workspace-restore.tar.gz";
            const archiveBuffer = Buffer.from(bodyBytes);

            await sandbox.files.write(
                archivePath,
                archiveBuffer.buffer.slice(archiveBuffer.byteOffset, archiveBuffer.byteOffset + archiveBuffer.byteLength) as ArrayBuffer,
            );

            // Extract into workspace directory
            const extractResult = await sandbox.commands.run(
                `mkdir -p ${WORKSPACE_DIR} && cd ${WORKSPACE_DIR} && tar xzf ${archivePath} && rm ${archivePath}`,
                { timeoutMs: 60_000 },
            );

            if (extractResult.exitCode !== 0) {
                return { error: `Extract failed: ${extractResult.stderr}`, success: false };
            }

            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            return { error: errorMessage, success: false };
        }
    });
