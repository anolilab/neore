/**
 * Remembers an update that was downloaded so the next start can tell whether it was applied. The updater installs on quit;
 * when the app comes back on the old version (the installer was blocked, the app was killed, a permission was missing) the
 * person would otherwise keep running a build they believe is new. Pure rules here, plain `fs` for the file; the file is
 * ours and its contents are only ever compared, never run.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const PENDING_UPDATE_FILE = "pending-update.json";

export interface PendingUpdate {
    /** Set once the person has been told it was not applied, so a restart does not say it again. */
    noticed?: boolean;
    version: string;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)/u;

/** `a` against `b` by major, minor and patch; `undefined` when either is not a version (a pre-release suffix is ignored). */
export const compareVersions = (a: string, b: string): number | undefined => {
    const left = VERSION.exec(a);
    const right = VERSION.exec(b);

    if (!left || !right) {
        return undefined;
    }

    for (let index = 1; index <= 3; index += 1) {
        const difference = Number(left[index]) - Number(right[index]);

        if (difference !== 0) {
            return Math.sign(difference);
        }
    }

    return 0;
};

export const parsePendingUpdate = (raw: string | undefined): PendingUpdate | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    try {
        const data = JSON.parse(raw) as { noticed?: unknown; version?: unknown };

        if (typeof data.version !== "string" || data.version.length > 64 || !VERSION.test(data.version)) {
            return undefined;
        }

        return { version: data.version, ...data.noticed === true && { noticed: true } };
    } catch {
        return undefined;
    }
};

/**
 * What a start finds: `none` (nothing waiting), `applied` (the downloaded version is the running one or older, so the record
 * can go), `still-pending` (still on the older version and the person was already told) or `not-applied` (still on the older
 * version, and this is the first start to notice).
 */
export type UpdateOutcome = { kind: "applied" } | { kind: "none" } | { kind: "still-pending" } | { current: string; kind: "not-applied"; version: string };

/** What a start finds: the record against the version that is running now. */
export const decideUpdateOutcome = (pending: PendingUpdate | undefined, current: string): UpdateOutcome => {
    if (!pending) {
        return { kind: "none" };
    }

    const order = compareVersions(current, pending.version);

    if (order === undefined || order >= 0) {
        return { kind: "applied" };
    }

    return pending.noticed === true ? { kind: "still-pending" } : { current, kind: "not-applied", version: pending.version };
};

const read = (file: string): string | undefined => {
    try {
        return readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
};

export const readPendingUpdate = (file: string): PendingUpdate | undefined => parsePendingUpdate(read(file));

export const writePendingUpdate = (file: string, pending: PendingUpdate): void => {
    const temporary = `${file}.tmp`;

    writeFileSync(temporary, JSON.stringify(pending));
    renameSync(temporary, file);
};

export const clearPendingUpdate = (file: string): void => {
    rmSync(file, { force: true });
};
