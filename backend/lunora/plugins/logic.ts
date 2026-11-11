/**
 * The plugin rules that need no database: the status table and the lease, the marker,
 * the content hash, the update diff, the version order and the export selection.
 */
import type { Infer } from "lunorash/server";

import { sha256Hex } from "../lib/crypto";
import { vPluginInstallStatus, vPluginItemKind, vPluginItemState } from "./validators";

/** A holder keeps its lease this long; nothing runs past it. */
export const LEASE_MS = 5 * 60 * 1000;

/** A sharded write (triggers, threads) needs at least this much lease left before it writes. */
export const SHARD_WRITE_MIN_LEFT_MS = 60 * 1000;

export type InstallStatus = Infer<typeof vPluginInstallStatus>;

export type ChildKind = Infer<typeof vPluginItemKind>;

export type ChildState = Infer<typeof vPluginItemState>;

export type InstallAction = "update" | "uninstall" | "repair";

/**
 * The actions that may run from each status. A status with no holder (`installed`, `needs-repair`)
 * is always open. A status with a holder (`installing`, `updating`, `uninstalling`) opens only
 * once its lease has expired, and then only the actions that finish or undo the half-done work.
 */
export const actionsFor = (status: InstallStatus, leaseExpired: boolean): InstallAction[] => {
    switch (status) {
        case "installed": {
            return ["update", "uninstall"];
        }
        case "needs-repair": {
            return ["repair", "uninstall"];
        }
        case "installing": {
            return leaseExpired ? ["repair", "uninstall"] : [];
        }
        case "updating": {
            return leaseExpired ? ["repair"] : [];
        }
        case "uninstalling": {
            return leaseExpired ? ["repair", "uninstall"] : [];
        }
    }
};

export const leaseExpired = (leaseUntil: number, now: number): boolean => now >= leaseUntil;

/**
 * A sharded write checks two things before it writes: the install row's generation is still the one it
 * started under, and the lease has enough time left to finish the write.
 */
export const shardWriteAllowed = (started: { generation: number }, current: { generation: number; leaseUntil: number }, now: number): boolean =>
    current.generation === started.generation && current.leaseUntil - now >= SHARD_WRITE_MIN_LEFT_MS;

/** The marker a child carries, so repair can find it by index. */
export const markerFor = (installId: string, entryKey: string): string => `${installId}:${entryKey}`;

/** The install id and entry key a marker names, or null for a marker not written by {@link markerFor}. */
export const parseMarker = (marker: string): { entryKey: string; installId: string } | null => {
    const separator = marker.indexOf(":");

    if (separator <= 0 || separator === marker.length - 1) {
        return null;
    }

    return { entryKey: marker.slice(separator + 1), installId: marker.slice(0, separator) };
};

/** JSON with object keys sorted at every depth, so the same content always serialises the same way. */
export const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    }

    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }

    return JSON.stringify(value);
};

/** The frontmatter block at the top of a bundle file: the header, which is not part of the hashed content. */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;

/**
 * The content hash of a plugin file: SHA-256 of its body, with the header removed and line endings normalised.
 * The header carries this hash, so the hash cannot cover the header. Any change to an item changes it.
 */
export const bodyHash = async (markdown: string): Promise<string> => await sha256Hex(markdown.replace(FRONTMATTER_RE, "").replaceAll("\r\n", "\n"));

/** The content hash of one plugin entry, over its canonical fields. Any change to the instruction, schedule or name changes it. */
export const contentHash = async (content: unknown): Promise<string> => await sha256Hex(canonicalJson(content));

/**
 * One child as the install last wrote it. `currentHash` is the hash of its live content now, and
 * `pendingHash` is set only while an in-place update is half done.
 */
export interface InstalledChild {
    contentHash: string;
    currentHash: string;
    entryKey: string;
    kind: ChildKind;
    pendingHash?: string;
}

/** One entry of the new version, with the hash of its canonical content. */
export interface IncomingEntry {
    contentHash: string;
    entryKey: string;
    kind: ChildKind;
}

export type UpdateAction = "create" | "delete" | "detach" | "keep-edited" | "report-group" | "same" | "update";

/**
 * What an update does with each child, matched by entry key. An edited child is never overwritten. A
 * group whose definition changed is reported, not changed. A child whose kind changed is replaced.
 * A child caught mid-update (its live hash is its pending hash) is not an edit: the update finishes it.
 */
export const diffUpdate = (
    installed: ReadonlyArray<InstalledChild>,
    incoming: ReadonlyArray<IncomingEntry>,
): Array<{ action: UpdateAction; entryKey: string }> => {
    const byKey = new Map(installed.map((child) => [child.entryKey, child]));
    const incomingKeys = new Set(incoming.map((entry) => entry.entryKey));
    const plan: Array<{ action: UpdateAction; entryKey: string }> = [];

    for (const entry of incoming) {
        const child = byKey.get(entry.entryKey);

        if (!child) {
            plan.push({ action: "create", entryKey: entry.entryKey });
            continue;
        }

        const edited = child.currentHash !== child.contentHash && child.currentHash !== child.pendingHash;

        if (entry.kind !== child.kind) {
            plan.push({ action: edited ? "detach" : "delete", entryKey: entry.entryKey }, { action: "create", entryKey: entry.entryKey });
        } else if (child.kind === "group" && entry.contentHash !== child.contentHash) {
            plan.push({ action: "report-group", entryKey: entry.entryKey });
        } else if (edited) {
            plan.push({ action: "keep-edited", entryKey: entry.entryKey });
        } else if (entry.contentHash === child.contentHash) {
            plan.push({ action: "same", entryKey: entry.entryKey });
        } else {
            plan.push({ action: "update", entryKey: entry.entryKey });
        }
    }

    for (const child of installed) {
        if (incomingKeys.has(child.entryKey)) {
            continue;
        }

        if (child.kind === "group") {
            plan.push({ action: "report-group", entryKey: child.entryKey });
            continue;
        }

        plan.push({ action: child.currentHash === child.contentHash ? "delete" : "detach", entryKey: child.entryKey });
    }

    return plan;
};

const VERSION_RE = /^\d+\.\d+\.\d+$/u;

/**
 * Compares two `major.minor.patch` versions: negative when `a` is older, positive when newer, zero when equal.
 * A version that is not exactly three numbers throws; the manifest is validated before any version reaches here.
 */
export const compareVersions = (a: string, b: string): number => {
    const malformed = [a, b].find((version) => !VERSION_RE.test(version));

    if (malformed !== undefined) {
        throw new Error(`not a major.minor.patch version: ${malformed}`);
    }

    const left = a.split(".").map((part) => Number(part));
    const right = b.split(".").map((part) => Number(part));

    for (let index = 0; index < 3; index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);

        if (difference !== 0) {
            return difference;
        }
    }

    return 0;
};

export const isDowngrade = (from: string, to: string): boolean => compareVersions(to, from) < 0;

/**
 * An export is a plugin only when it selects exactly the children of one installed plugin, each one
 * created, unedited and with no pending update, and the install itself is `installed`. Anything else is a plain bundle.
 */
export const isCompletePluginExport = (
    install: { status: InstallStatus },
    children: ReadonlyArray<{ contentHash: string; currentHash: string; id: string; pendingHash?: string; state: ChildState }>,
    selectedIds: ReadonlySet<string>,
): boolean => {
    if (install.status !== "installed" || children.length === 0 || selectedIds.size !== children.length) {
        return false;
    }

    return children.every(
        (child) => selectedIds.has(child.id) && child.state === "created" && child.pendingHash === undefined && child.currentHash === child.contentHash,
    );
};
