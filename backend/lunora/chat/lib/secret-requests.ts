/**
 * Values the agent asked the user for (`requestSecret`, `chat/tools/request-secret.ts`):
 * the plain functions over `ctx.db` that store one behind an opaque reference and
 * take it back out exactly once.
 *
 * The plaintext is encrypted the way BYOK provider keys are (`lib/encryption.ts`,
 * `provider-keys`) before it is written, and it leaves the row only inside
 * {@link takeRequestedSecret}, which also marks the row `used` and drops the
 * ciphertext in the same write. A reference is bound to the user AND the thread
 * that asked, so a copy of it in a fork or a share view is worthless.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { decryptKey, encryptKey } from "../../lib/encryption";
import { patchRow } from "../../lib/patch";
import type { SecretFailure, SecretUse } from "../tools/request-secret-constants";
import {
    isForbiddenSecretHeader,
    SECRET_HEADER_NAME_MAX,
    SECRET_HEADER_NAME_RE,
    SECRET_HEADER_VALUE_MAX,
    SECRET_PROVIDER_KEY_MAX,
    SECRET_PROVIDERS,
    SECRET_TTL_MS,
} from "../tools/request-secret-constants";

type Database = Pick<MutationCtx, "db">;

const REF_PREFIX = "sec_";

/** An unguessable, URL-safe reference. */
export const newSecretRef = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));

    return `${REF_PREFIX}${btoa(String.fromCodePoint(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")}`;
};

export const secretExpiresAt = (now: number): number => now + SECRET_TTL_MS;

export const isSecretExpired = (row: { expiresAt: number }, now: number): boolean => row.expiresAt <= now;

/** The longest value the destination takes, as a manual save would cap it. */
export const secretValueMax = (use: SecretUse): number => (use.kind === "provider_key" ? SECRET_PROVIDER_KEY_MAX : SECRET_HEADER_VALUE_MAX);

/** A reason a request names a destination that does not exist, or `undefined` when it is acceptable. */
export const invalidSecretUse = (use: SecretUse): string | undefined => {
    if (use.kind === "provider_key") {
        return (SECRET_PROVIDERS as ReadonlyArray<string>).includes(use.provider) ? undefined : `Unknown provider "${use.provider}"`;
    }

    if (use.server.trim().length === 0) {
        return "Name the MCP server";
    }

    if (use.header.length === 0 || use.header.length > SECRET_HEADER_NAME_MAX || !SECRET_HEADER_NAME_RE.test(use.header)) {
        return "Not a valid header name";
    }

    return isForbiddenSecretHeader(use.header) ? `A secret cannot be sent as the ${use.header} header` : undefined;
};

/** Store `value` for `row.userId`'s thread and return the reference that stands for it. The caller stamps `userId` from the claimed run, never from a client. */
export const storeRequestedSecret = async (
    ctx: Database,
    row: {
        approvalId: string;
        label: string;
        now: number;
        /** The reply that asked; its end drops the value ({@link discardThreadSecrets}). */
        replyKey?: string;
        threadId: Id<"threads">;
        use: SecretUse;
        userId: string;
        value: string;
    },
): Promise<string> => {
    const ref = newSecretRef();

    await ctx.db.insert("requestedSecrets", {
        approvalId: row.approvalId,
        createdAt: row.now,
        encryptedValue: await encryptKey(row.value, "provider-keys"),
        expiresAt: secretExpiresAt(row.now),
        label: row.label,
        ref,
        ...(row.replyKey !== undefined && { replyKey: row.replyKey }),
        status: "saved",
        threadId: row.threadId,
        use: row.use,
        userId: row.userId,
    });

    return ref;
};

export type TakenSecret = { ok: false; status: SecretFailure } | { ok: true; use: SecretUse; value: string };

/** Says whether the destination the user approved exists; the reference is left unused when it does not. */
type DestinationCheck = (use: SecretUse) => boolean;

/**
 * Take the value behind `ref` for a consumer of `kind`. It works once: the row
 * becomes `used` and its ciphertext is removed in the same write, so a second
 * call (or a redelivered tool call) finds nothing to read. A throw by the caller
 * afterwards rolls the whole mutation back, restoring the value.
 */
export const takeRequestedSecret = async (
    ctx: Database,
    args: { kind: SecretUse["kind"]; now: number; ref: string; startedBy: string; threadId: string; userId: string },
    destinationExists: DestinationCheck = () => true,
): Promise<TakenSecret> => {
    const row = await ctx.db
        .query("requestedSecrets")
        .withIndex("by_ref", (q) => q.eq("ref", args.ref))
        .first();

    // One answer for a missing ref and for someone else's, so a ref's existence is not revealed.
    if (!row || row.userId !== args.userId || row.threadId !== args.threadId) {
        return { ok: false, status: "not_found" };
    }

    // The spending turn must be one the owner started: a continuation runs as the owner whoever started the turn it resumes.
    if (args.startedBy !== row.userId) {
        return { ok: false, status: "wrong_run" };
    }

    if (isSecretExpired(row, args.now)) {
        if (row.encryptedValue !== undefined) {
            await patchRow(ctx.db, row, { encryptedValue: undefined });
        }

        return { ok: false, status: "expired" };
    }

    if (row.status === "used" || row.encryptedValue === undefined) {
        return { ok: false, status: "used" };
    }

    if (row.use.kind !== args.kind) {
        return { ok: false, status: "wrong_use" };
    }

    if (!destinationExists(row.use)) {
        return { ok: false, status: "destination_missing" };
    }

    let value: string;

    try {
        value = await decryptKey(row.encryptedValue, "provider-keys");
    } catch {
        await patchRow(ctx.db, row, { encryptedValue: undefined, status: "used" });

        return { ok: false, status: "unreadable" };
    }

    await patchRow(ctx.db, row, { encryptedValue: undefined, status: "used" });

    return { ok: true, use: row.use, value };
};

/**
 * The reply a stream belongs to: the key its approval snapshot carries when the stream is a continuation, or the
 * stream's own id when it is the reply's first run (whose snapshot is stamped with that id).
 */
export const replyKeyOfStream = async (ctx: Database, args: { streamId: string; threadId: Id<"threads"> }): Promise<string> => {
    const runs = await ctx.db
        .query("toolApprovalRuns")
        .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
        .collect();

    return runs.find((run) => run.streamId === args.streamId)?.config.replyKey ?? args.streamId;
};

/**
 * Drop the ciphertext of the references of one reply (`replyKey`) that are still saved on `threadId`, keeping the rows
 * (a later spend reads `used`). Called when that reply ends for good — finished, failed or stopped, never at a pause —
 * so a value does not wait out its 24 hours once the reply that received it is over, and another reply on the thread
 * keeps its own. Returns how many it dropped.
 *
 * What remains: the row itself (status, label, destination, ref, approvalId, expiresAt) until the sweep; and the
 * ciphertext of a reply that never reached an end — a worker killed mid-continuation, or a stream the timeout reaper
 * closed, which does not call this — until its `expiresAt` passes and the housekeeping sweep (every 10 minutes on a
 * shard that was active, else daily for 30 days) deletes the row. A decline stores nothing at all.
 */
export const discardThreadSecrets = async (ctx: Database, args: { replyKey: string; threadId: Id<"threads"> }): Promise<number> => {
    const rows = await ctx.db
        .query("requestedSecrets")
        .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
        .collect();
    const live = rows.filter((row) => row.encryptedValue !== undefined && row.replyKey === args.replyKey);

    for (const row of live) {
        await patchRow(ctx.db, row, { encryptedValue: undefined });
    }

    return live.length;
};

/** Delete every row of `threadId`, ciphertext included — the thread is gone, and so is whatever a reply of it was holding. Returns how many. */
export const deleteThreadSecrets = async (ctx: Database, args: { threadId: Id<"threads"> }): Promise<number> => {
    const rows = await ctx.db
        .query("requestedSecrets")
        .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
        .collect();

    for (const row of rows) {
        await ctx.db.delete(row._id);
    }

    return rows.length;
};

/** Delete the rows on this shard whose reference lapsed, whatever their status. Returns how many. */
export const sweepExpiredSecrets = async (ctx: Database, now: number, limit: number): Promise<number> => {
    const rows = await ctx.db
        .query("requestedSecrets")
        .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
        .take(limit);

    for (const row of rows) {
        await ctx.db.delete(row._id);
    }

    return rows.length;
};
