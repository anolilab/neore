import { LunoraError } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** The longest folder path a project may record, in UTF-8 bytes. */
export const MAX_PROJECT_PATH_BYTES = 1024;

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[/\\])/u;

const textEncoder = new TextEncoder();

/** `true` for a path within the byte cap, with no NUL, that starts at a root (`/…` or a drive such as `C:\…`). */
export const isProjectFolderPath = (path: string): boolean =>
    ABSOLUTE_PATH.test(path) && !path.includes("\u{0}") && textEncoder.encode(path).length <= MAX_PROJECT_PATH_BYTES;

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
