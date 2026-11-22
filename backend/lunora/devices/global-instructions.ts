/**
 * "Import from this computer" in a project's rule-file editor: the one device call a chat does not start. A click
 * in project settings signs a call for the caller's OWN paired, online desktop, either listing which of the global
 * instruction files AI tools keep there exist (`instructions_list`: names and sizes, no contents) or reading the
 * ones the person ticked (`instructions_read`). The desktop's Rust core holds the list of files
 * (`packages/device-core/src/global_instructions.rs`): the request only picks from it by id, never names a path.
 *
 * The call is signed, relayed, approved in the desktop's window (always asked, never "Always allow") and recorded
 * exactly like any other device call; it has no thread. Nothing else is stored: the files reach the editor as unsaved
 * drafts.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, authQuery } from "../lib/crpc";
import { decryptKey } from "../lib/encryption";
import { checkRateLimit } from "../lib/rate-limiter";
import {
    DEVICE_CALL_DEADLINE_MS,
    GLOBAL_INSTRUCTIONS_LIST_TOOL,
    GLOBAL_INSTRUCTIONS_READ_TOOL,
    isGlobalInstructionsTool,
    MAX_OPEN_CALLS_PER_DEVICE,
} from "./lib/constants";
import { signDevicePayload } from "./lib/signing";
import { countOpenCalls, isAcpTool, isDeviceOnline, isDeviceOutdated } from "./lib/state";
import { vDeviceCallStatus } from "./validators";

/** The ids the device knows, in its order. Keep in step with `FILES` in `global_instructions.rs`. */
export const GLOBAL_INSTRUCTION_FILE_IDS = ["claude", "codex", "gemini", "windsurf"] as const;

/** The `data.code` of a refusal the editor words itself. */
export const GLOBAL_INSTRUCTIONS_REFUSALS = { BUSY: "DEVICE_BUSY", OFFLINE: "DEVICE_OFFLINE", OUTDATED: "DEVICE_OUTDATED" } as const;

/** The `code` of a call the device answered but this side could not read, so the editor says it in the person's language. */
export const GLOBAL_INSTRUCTIONS_ANSWER_UNREADABLE = "ANSWER_UNREADABLE";

/** What the desktop's approval window names as the call's origin, where a chat call names its thread. */
const ORIGIN_TITLE = "Import into a project's rule files";

const vFileId = v.union(v.literal("claude"), v.literal("codex"), v.literal("gemini"), v.literal("windsurf"));

const vFileEntry = v.object({
    id: vFileId,
    name: v.string(),
    path: v.string(),
    reason: v.optional(v.string()),
    // An earlier file this one leads to (a link): the same text, imported once.
    sameAs: v.optional(vFileId),
    size: v.optional(v.number()),
    status: v.union(v.literal("found"), v.literal("left_out"), v.literal("missing"), v.literal("read"), v.literal("refused"), v.literal("too_large")),
    text: v.optional(v.string()),
});

const STATUSES: ReadonlySet<string> = new Set(["found", "left_out", "missing", "read", "refused", "too_large"]);
const IDS: ReadonlySet<string> = new Set(GLOBAL_INSTRUCTION_FILE_IDS);

type FileEntry = Infer<typeof vFileEntry>;

const byteCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

const text = (value: unknown, max: number): string | undefined => (typeof value === "string" ? value.slice(0, max) : undefined);

/** The device's signed output, kept to the fields and ids this side knows; anything else is dropped. */
export const parseGlobalInstructionFiles = (output: string | undefined): FileEntry[] | undefined => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(output ?? "");
    } catch {
        return undefined;
    }

    if (!Array.isArray(parsed)) {
        return undefined;
    }

    const files = parsed.flatMap((raw: unknown): FileEntry[] => {
        const entry = (raw ?? {}) as Record<string, unknown>;

        if (typeof entry.id !== "string" || !IDS.has(entry.id) || typeof entry.status !== "string" || !STATUSES.has(entry.status)) {
            return [];
        }

        const reason = text(entry.reason, 200);
        const body = text(entry.text, 100_000);
        const size = byteCount(entry.size);
        const sameAs = typeof entry.sameAs === "string" && IDS.has(entry.sameAs) && entry.sameAs !== entry.id ? (entry.sameAs as FileEntry["id"]) : undefined;

        return [
            {
                id: entry.id as FileEntry["id"],
                name: text(entry.name, 100) ?? entry.id,
                path: text(entry.path, 200) ?? "",
                status: entry.status as FileEntry["status"],
                ...(reason !== undefined && { reason }),
                ...(sameAs !== undefined && { sameAs }),
                ...(size !== undefined && { size }),
                ...(body !== undefined && { text: body }),
            },
        ];
    });

    // Entries were sent but none is one this side knows: unreadable, not "no files".
    return files.length === 0 && parsed.length > 0 ? undefined : files;
};

/**
 * Starts one call on the caller's own desktop. `files` absent lists; present, reads those ids. Refused (NOT_FOUND,
 * like a missing one) for a device that is not the caller's, and for a server reached over SSH or a machine paired by
 * code: only a desktop that is the person's own computer takes it.
 */
export const startGlobalInstructionsCall = authMutation
    .input({
        deviceId: v.id("devices"),
        files: v.optional(
            v.array(vFileId).check((ids) => ids.length > 0 && ids.length <= GLOBAL_INSTRUCTION_FILE_IDS.length && new Set(ids).size === ids.length, {
                message: "Pick between one and four different files",
            }),
        ),
    })
    .output(v.object({ callId: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const { impersonatedBy, userId } = ctx.user;

        if (impersonatedBy) {
            throw new LunoraError("FORBIDDEN", "A device cannot be used while impersonating");
        }

        if (await isAccountDeletionUnderway(ctx, userId)) {
            throw new LunoraError("FORBIDDEN", "This account is being deleted");
        }

        const device = await ctx.db.devices.findFirst({ where: { _id: args.deviceId, userId } });

        if (!device || device.viaDeviceId !== undefined || device.transport !== undefined || device.encryptedSecret === undefined) {
            throw new LunoraError("NOT_FOUND", "Device not found");
        }

        const { now } = ctx;

        if (isDeviceOutdated(device)) {
            throw new LunoraError("CONFLICT", "This computer's app is out of date", { data: { code: GLOBAL_INSTRUCTIONS_REFUSALS.OUTDATED } });
        }

        if (!isDeviceOnline(device, now)) {
            throw new LunoraError("CONFLICT", "This computer is offline", { data: { code: GLOBAL_INSTRUCTIONS_REFUSALS.OFFLINE } });
        }

        if ((await countOpenCalls(ctx, device._id, (call) => !isAcpTool(call.toolName), MAX_OPEN_CALLS_PER_DEVICE)) >= MAX_OPEN_CALLS_PER_DEVICE) {
            throw new LunoraError("TOO_MANY_REQUESTS", "This computer is busy", { data: { code: GLOBAL_INSTRUCTIONS_REFUSALS.BUSY } });
        }

        const limited = await checkRateLimit(ctx, "devices/call:free", { key: userId });

        if (!limited.ok) {
            throw new LunoraError("TOO_MANY_REQUESTS", "Too many requests");
        }

        const toolName = args.files === undefined ? GLOBAL_INSTRUCTIONS_LIST_TOOL : GLOBAL_INSTRUCTIONS_READ_TOOL;
        const input = args.files === undefined ? {} : { files: args.files };
        const deadline = now + DEVICE_CALL_DEADLINE_MS;
        const callId = await ctx.db.insert("deviceCalls", {
            createdAt: now,
            deadline,
            deviceId: device._id,
            deviceName: device.name,
            envelope: "",
            input: JSON.stringify(input),
            signature: "",
            status: "pending",
            taintedBy: [],
            toolName,
            userId,
        });
        const envelope = JSON.stringify({
            callId,
            deviceId: device._id,
            expiresAt: deadline,
            input,
            issuedAt: now,
            kind: "call",
            nonce: crypto.randomUUID(),
            taintedBy: [],
            threadTitle: ORIGIN_TITLE,
            tool: toolName,
            v: 1,
        });
        const secret = await decryptKey(device.encryptedSecret, "device-secrets");

        await ctx.db.patch("deviceCalls", callId, { envelope, signature: await signDevicePayload(secret, "call", envelope) });

        ctx.log.event("devices.start_global_instructions_call", { files: args.files?.length ?? 0, tool: toolName });

        return { callId: callId as string };
    });

/**
 * Where one such call is and, once the device answered, its files. The caller's own calls of these two tools only,
 * and never to an impersonating admin: the files are the person's own, as starting a call is.
 */
export const getGlobalInstructionsCall = authQuery
    .input({ callId: v.id("deviceCalls") })
    .output(
        v.union(
            v.null(),
            v.object({
                code: v.optional(v.literal("ANSWER_UNREADABLE")),
                error: v.optional(v.string()),
                files: v.optional(v.array(vFileEntry)),
                phase: v.optional(v.union(v.literal("prompting"), v.literal("running"))),
                status: vDeviceCallStatus,
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        if (ctx.user.impersonatedBy) {
            throw new LunoraError("FORBIDDEN", "A device cannot be used while impersonating");
        }

        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId as Id<"deviceCalls">, userId: ctx.user.userId } });

        if (!call || !isGlobalInstructionsTool(call.toolName)) {
            return null;
        }

        const files = call.status === "completed" ? parseGlobalInstructionFiles(call.output) : undefined;

        // A result the device sent but this side cannot read is a failed import, never one that found no files.
        if (files === undefined && call.status === "completed") {
            return { code: GLOBAL_INSTRUCTIONS_ANSWER_UNREADABLE, error: "The computer's answer could not be read", status: "failed" as const };
        }

        ctx.log.event("devices.get_global_instructions_call", { files: files?.length ?? 0, status: call.status });

        return {
            status: call.status,
            ...(call.error !== undefined && { error: call.error }),
            ...(files !== undefined && { files }),
            ...(call.phase !== undefined && { phase: call.phase }),
        };
    });
