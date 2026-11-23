import { LunoraError } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { patchRow } from "../lib/patch";

/** The longest folder path a project may record, in UTF-8 bytes. */
export const MAX_PROJECT_PATH_BYTES = 1024;

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[/\\])/u;

const textEncoder = new TextEncoder();

/** `true` for a path within the byte cap, with no NUL, that starts at a root (`/…` or a drive such as `C:\…`). */
export const isProjectFolderPath = (path: string): boolean =>
    ABSOLUTE_PATH.test(path) && !path.includes("\u{0}") && textEncoder.encode(path).length <= MAX_PROJECT_PATH_BYTES;

/**
 * The project as `viewerId` may see it. A machine belongs to its owner alone, so the machine and folder (a device id and
 * an absolute path that often carries the OS username) are dropped for anyone else, such as another member of the
 * project's organization. So is the owner's runner (`acp/lib/project-runner.ts`): a project moved into an organization
 * keeps the id and start time of the owner's last host thread, which no member reads. Every project row a client reads
 * passes through here.
 */
export const forViewer = <T extends { machineId?: unknown; path?: unknown; userId?: string | null }>(project: T, viewerId: string): T => {
    if (project.userId === viewerId) {
        return project;
    }

    // The names are dropped by the rest pattern, never read: that is how the fields leave the row.
    /* eslint-disable sonarjs/no-unused-vars -- the rest pattern is the point of this statement */
    const {
        machineId: _machineId,
        path: _path,
        runnerAgentKey: _runnerAgentKey,
        runnerDeviceId: _runnerDeviceId,
        runnerFolderId: _runnerFolderId,
        runnerKind: _runnerKind,
        runnerThreadAt: _runnerThreadAt,
        runnerThreadId: _runnerThreadId,
        ...rest
    } = project as Partial<Record<`runner${"AgentKey" | "DeviceId" | "FolderId" | "Kind" | "ThreadAt" | "ThreadId"}`, unknown>> & T;
    /* eslint-enable sonarjs/no-unused-vars */

    return rest as T;
};

/**
 * Checks the machine and folder a new project records and returns them. The device must be the caller's own and
 * not revoked (a missing, foreign or revoked one is the same `NOT_FOUND`); the folder is required with it.
 */
export const resolveProjectLocation = async (
    ctx: Pick<MutationCtx, "db">,
    userId: string,
    machineId: Id<"devices"> | undefined,
    path: string | undefined,
): Promise<{ machineId?: Id<"devices">; path?: string }> => {
    if (machineId === undefined) {
        if (path !== undefined) {
            throw new LunoraError("BAD_REQUEST", "A folder needs a machine");
        }

        return {};
    }

    const device: Doc<"devices"> | null = await ctx.db.devices.findFirst({ where: { _id: machineId, userId } });

    if (!device || device.revokedAt !== undefined) {
        throw new LunoraError("NOT_FOUND", "Machine not found");
    }

    if (path === undefined || !isProjectFolderPath(path)) {
        throw new LunoraError("BAD_REQUEST", "The folder must be an absolute path of at most 1024 bytes");
    }

    return { machineId, path };
};

/**
 * Projects one scheduled run clears; a run that clears a full batch schedules the next (`clearDeviceProjects`).
 * Each project is one D1 write, so 20 keeps a run within the free plan's per-invocation query limit.
 */
export const MACHINE_CLEAR_BATCH = 20;

/**
 * Removes the machine and folder from up to one batch of the user's projects that live on `machineId`; the projects stay.
 * Resolves to `true` when the batch was full, so projects may remain. Idempotent: a repeated run finds fewer rows or none.
 */
export const clearMachineFromProjects = async (ctx: Pick<MutationCtx, "db">, userId: string, machineId: Id<"devices">): Promise<boolean> => {
    // Primary: a replica that lags could miss a project written just before the revoke, leaving it on the deleted machine.
    const { page } = await ctx.db.projects.findMany({ consistency: "primary", limit: MACHINE_CLEAR_BATCH, where: { machineId, userId } });

    for (const project of page) {
        await patchRow(ctx.db, "projects", project, { machineId: undefined, path: undefined });
    }

    return page.length === MACHINE_CLEAR_BATCH;
};
