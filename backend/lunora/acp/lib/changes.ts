/**
 * What a host turn changed, as the reply stores it and the UI reads it (plans/acp-agent-host.md §4.9). It rides
 * on the reply row's `providerMetadata.neore.hostChanges`: a new content part would reach model conversion on a
 * fork, and the row is saved once, when the turn ends, so the patch is frozen there.
 */

export interface HostChanges {
    files: { added: number; path: string; removed: number }[];
    /** The unified diff; absent when the host sent none, `tooLarge` when it did not fit. */
    patch?: string | { tooLarge: true };
}

const DRIVE_PATH = /^[A-Za-z]:/u;
// A control character in a path could forge a line of the patch.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u{0}-\u{1F}]/u;
const SEPARATOR = /[/\\]/u;

/** A path relative to the approved folder: not absolute, no `..`, no drive, no control characters. */
export const isFolderRelativePath = (path: string): boolean =>
    !path.startsWith("/") && !path.startsWith("\\") && !DRIVE_PATH.test(path) && !CONTROL_CHARACTER.test(path) && !path.split(SEPARATOR).includes("..");

/** The summary a row carries, or undefined. The column is opaque JSON, so the shape is checked on the way out too. */
export const readHostChanges = (providerMetadata: unknown): HostChanges | undefined => {
    const stored = (providerMetadata as { neore?: { hostChanges?: unknown } } | null | undefined)?.neore?.hostChanges as Partial<HostChanges> | undefined;

    if (!stored || !Array.isArray(stored.files) || stored.files.length === 0) {
        return undefined;
    }

    return { files: stored.files, ...(stored.patch !== undefined && { patch: stored.patch }) };
};
