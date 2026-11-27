/**
 * The lease checks every plugin step shares. A step holds the install only while the generation it started under is still the
 * current one AND, for a status that carries a lease (`installing`, `updating`), the lease has not run out: an action whose lease
 * expired may already have been taken over by repair or a new run, so it must write nothing more (`STALE_LEASE`).
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { shardWriteAllowed } from "./logic";

export const STALE = "STALE_LEASE: this install was taken over by another action";

const LEASED = new Set(["installing", "updating"]);

/** The install row, after checking that the caller still holds the lease it started under. */
export const heldInstall = async (ctx: Pick<MutationCtx, "db" | "now">, installId: Id<"pluginInstalls">, generation: number) => {
    const install = await ctx.db.pluginInstalls.findFirst({ where: { _id: installId } });

    if (!install || install.generation !== generation) {
        throw new LunoraError("CONFLICT", STALE);
    }

    if (LEASED.has(install.status) && install.leaseUntil !== undefined && install.leaseUntil <= ctx.now) {
        throw new LunoraError("CONFLICT", STALE);
    }

    return install;
};

/** The same check for a write to a sharded table (triggers, threads): the lease must also have time left to finish the write. */
export const heldInstallForShardWrite = async (ctx: Pick<MutationCtx, "db" | "now">, installId: Id<"pluginInstalls">, generation: number) => {
    const install = await heldInstall(ctx, installId, generation);

    if (
        LEASED.has(install.status) &&
        install.leaseUntil !== undefined &&
        !shardWriteAllowed({ generation }, { generation: install.generation, leaseUntil: install.leaseUntil }, ctx.now)
    ) {
        throw new LunoraError("CONFLICT", STALE);
    }

    return install;
};

/**
 * Writes the install row only while its stored generation is still the one the caller holds. The read in {@link heldInstall} and a
 * later plain patch are separate statements on a `.global()` table, so a takeover can land between them; this write is conditional, and
 * a miss is `STALE_LEASE`. Writes to `pluginItems` cannot be fenced against the install row this way, so a step that writes both
 * writes the install row first.
 */
export const patchInstallIf = async (
    ctx: Pick<MutationCtx, "db">,
    installId: Id<"pluginInstalls">,
    generation: number,
    patch: Record<string, unknown>,
    stale: string = STALE,
): Promise<void> => {
    const { applied } = await ctx.db.patchIf("pluginInstalls", installId, { patch: patch as never, where: { generation } });

    if (!applied) {
        throw new LunoraError("CONFLICT", stale);
    }
};
