/**
 * The per-user knowledge-base quota: how many files, and how many bytes in
 * total. Every file an add schedules is fetched or read, parsed, chunked,
 * embedded and summarised, and its object sits in R2 — so the rate limits,
 * which only pace adds, need a ceiling on what accumulates. Checked by every
 * insert of a `knowledgeFiles` row (`addFile`, `addDocuments`, `addUrl`).
 *
 * A URL's size is unknown until it is fetched (it is stored as 0, then the
 * text's length), so URLs count toward the file limit only when added.
 */
import { LunoraError } from "lunorash/server";

import type { MutationCtx } from "../_generated/server";
import { getUserTier } from "../lib/rate-limiter";

export type KnowledgeTier = "free" | "premium";

export const KNOWLEDGE_QUOTA: Record<KnowledgeTier, { maxBytes: number; maxFiles: number }> = {
    free: { maxBytes: 100 * 1024 * 1024, maxFiles: 300 },
    premium: { maxBytes: 1024 * 1024 * 1024, maxFiles: 3000 },
};

/** The quota tier of a session user — the rate limiter's tier, so a paid plan gets the larger quota. */
export const knowledgeTierOf = (user: Parameters<typeof getUserTier>[0]): KnowledgeTier => (getUserTier(user) === "premium" ? "premium" : "free");

export const KNOWLEDGE_QUOTA_EXCEEDED = "KNOWLEDGE_QUOTA_EXCEEDED";

/** Why adding `adding` would take a user holding `used` past `quota`, or `undefined` when it fits. Pure. */
export const knowledgeQuotaProblem = (
    used: { bytes: number; files: number },
    adding: { bytes: number; files: number },
    quota: { maxBytes: number; maxFiles: number },
): string | undefined => {
    if (used.files + adding.files > quota.maxFiles) {
        return `Your knowledge base can hold at most ${String(quota.maxFiles)} files. Remove some before adding more.`;
    }

    if (used.bytes + adding.bytes > quota.maxBytes) {
        return `Your knowledge base can hold at most ${String(Math.round(quota.maxBytes / 1024 / 1024))} MB. Remove some files before adding more.`;
    }

    return undefined;
};

/**
 * Throws when adding `adding` would exceed `userId`'s quota. Reads at most
 * `maxFiles + 1` of their rows — the owner's own, on their shard.
 */
export const assertKnowledgeQuota = async (
    ctx: Pick<MutationCtx, "db">,
    userId: string,
    tier: KnowledgeTier,
    adding: { bytes: number; files: number },
): Promise<void> => {
    const quota = KNOWLEDGE_QUOTA[tier];
    const rows = await ctx.db
        .query("knowledgeFiles")
        .withIndex("by_userId_status", (q) => q.eq("userId", userId))
        .take(quota.maxFiles + 1);
    const used = { bytes: rows.reduce((total, row) => total + Math.max(0, row.size), 0), files: rows.length };
    const problem = knowledgeQuotaProblem(used, adding, quota);

    if (problem) {
        throw new LunoraError("FORBIDDEN", problem, { data: { code: KNOWLEDGE_QUOTA_EXCEEDED, message: problem } });
    }
};
