import type { NativeHostSpec } from "@/lib/native/bridge";

import type { AddProjectMachine, MachineServerSpec } from "../../../../../desktop/src/add-project-machines.types";

const DRIVE_ONLY = /^[a-z]:$/i;
const DRIVE_ROOT = /^[a-z]:[/\\]$/i;
const DRIVE_ABSOLUTE = /^[a-z]:[/\\]/i;
const MISSING_FOLDER = /not found/i;
const ALREADY_SHARED = /already shared|inside a share/i;
const FILE_PATH = /is a file/i;
const UNREADABLE_FOLDER = /cannot be read|too many entries/i;
const DECLINED = /declined/i;
const NOT_CONNECTED = /connect the server first/i;
const REFUSED_ROOT = /home folder or one above/i;
const TOO_MANY_ROOTS = /already has \d+ shared folders/i;

const UNSUPPORTED_HOST_KEY = /^This host uses (\S+) in ~\/\.ssh\/config/;
const MATCH_RULE_HOST = /Match rule in ~\/\.ssh\/config/;
const PAIR_THIS_COMPUTER_FIRST = /^Pair this computer with your account first/;

export type DisabledReasonKind = { kind: "match-rule" } | { kind: "other" } | { kind: "pair-this-computer" } | { key: string; kind: "unsupported-setting" };

/** Which of the desktop's reasons a row is disabled for, so the picker can say it in the person's language. */
export const classifyDisabledReason = (reason: string): DisabledReasonKind => {
    const unsupported = UNSUPPORTED_HOST_KEY.exec(reason);

    if (unsupported?.[1] !== undefined) {
        return { key: unsupported[1], kind: "unsupported-setting" };
    }

    if (MATCH_RULE_HOST.test(reason)) {
        return { kind: "match-rule" };
    }

    return PAIR_THIS_COMPUTER_FIRST.test(reason) ? { kind: "pair-this-computer" } : { kind: "other" };
};

/** The separator a path uses: a drive letter or a backslash means Windows, anything else is POSIX. */
const separatorOf = (path: string): "/" | "\\" => (path.includes("\\") && !path.includes("/") ? "\\" : "/");

/** Strips trailing separators, but keeps a root ("/" or "C:\") whole. */
const trimTrailing = (path: string): string => {
    const separator = separatorOf(path);
    let end = path.length;

    while (end > 1 && path[end - 1] === separator) {
        end -= 1;
    }

    const trimmed = path.slice(0, end);

    return DRIVE_ONLY.test(trimmed) ? `${trimmed}${separator}` : trimmed;
};

const isRoot = (path: string): boolean => path === "/" || DRIVE_ROOT.test(path);

/** The folder that holds `path`, or null at a root or for an empty path. */
export const parentPath = (path: string): string | null => {
    const trimmed = trimTrailing(path.trim());

    if (trimmed === "" || isRoot(trimmed)) {
        return null;
    }

    const separator = separatorOf(trimmed);
    const index = trimmed.lastIndexOf(separator);

    if (index === -1) {
        return null;
    }

    if (index === 0) {
        return separator;
    }

    const parent = trimmed.slice(0, index);

    return DRIVE_ONLY.test(parent) ? `${parent}${separator}` : parent;
};

/** The folder's own name: the project title for a folder. Empty for a root. */
export const lastSegment = (path: string): string => {
    const trimmed = trimTrailing(path.trim());

    if (isRoot(trimmed)) {
        return "";
    }

    return trimmed.slice(trimmed.lastIndexOf(separatorOf(trimmed)) + 1);
};

export const joinPath = (folder: string, name: string): string => {
    const base = trimTrailing(folder);
    const separator = separatorOf(base);

    return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
};

/** A path the desktop accepts: absolute, no NUL. */
export const isAbsolutePath = (path: string): boolean => !path.includes("\0") && (path.startsWith("/") || DRIVE_ABSOLUTE.test(path));

export type MachineRowState =
    | { kind: "disabled"; reason: string }
    | { kind: "needs-connect"; sshAlias: string }
    | { kind: "needs-pair"; spec: MachineServerSpec; sshAlias: string }
    | { kind: "ready"; machineId: string };

/** What picking a row does. A row with a reason, or with nothing to reach it by, is disabled. */
export const machineRowState = (machine: AddProjectMachine): MachineRowState => {
    if (machine.disabledReason !== null) {
        return { kind: "disabled", reason: machine.disabledReason };
    }

    if (machine.spec !== null && machine.sshAlias !== null) {
        return { kind: "needs-pair", spec: machine.spec, sshAlias: machine.sshAlias };
    }

    if (machine.id !== null && machine.status !== "not-connected") {
        return { kind: "ready", machineId: machine.id };
    }

    if (machine.kind === "server" && machine.sshAlias !== null) {
        return { kind: "needs-connect", sshAlias: machine.sshAlias };
    }

    return { kind: "disabled", reason: "" };
};

/** The shell's description of an ssh host, from the desktop's spec; the key file is sent only when the config names one. */
export const hostSpecOf = (spec: MachineServerSpec): NativeHostSpec => {
    return {
        address: spec.address,
        name: spec.name,
        port: spec.port,
        user: spec.user,
        ...(spec.identityFile !== null && { identityFile: spec.identityFile }),
    };
};

/** A folder on a server must be among that server's shared folders before a project can point at it. */
export const folderNeedsSharing = (machine: Pick<AddProjectMachine, "kind">): boolean => machine.kind === "server";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The desktop's refusal for a folder that is not there: the one case a typed path is created. */
export const isMissingFolderError = (error: unknown): boolean => MISSING_FOLDER.test(errorText(error));

/** The desktop's refusal for a folder that a share already covers: the project can go on. */
export const isAlreadySharedError = (error: unknown): boolean => ALREADY_SHARED.test(errorText(error));

/** The desktop's refusal for a path that is a file. */
export const isFilePathError = (error: unknown): boolean => FILE_PATH.test(errorText(error));

/** The desktop's refusal for a folder it cannot list, or one with too many entries to list. */
export const isUnreadableFolderError = (error: unknown): boolean => UNREADABLE_FOLDER.test(errorText(error));

/** The desktop's refusal when the person declined the confirmation in its window. */
export const isDeclinedError = (error: unknown): boolean => DECLINED.test(errorText(error));

/** The desktop's refusal for a folder that is the server's home folder or one above it. */
export const isRefusedRootError = (error: unknown): boolean => REFUSED_ROOT.test(errorText(error));

/** The desktop's refusal when a server already has its maximum of shared folders. */
export const isTooManyRootsError = (error: unknown): boolean => TOO_MANY_ROOTS.test(errorText(error));

/** A refusal that is about the folder path the person typed or picked, not about the machine or the account. */
export const isPathFailure = (error: unknown): boolean =>
    isMissingFolderError(error) || isFilePathError(error) || isUnreadableFolderError(error) || isRefusedRootError(error);

/** The desktop's refusal for a server that is not connected yet. */
export const isNotConnectedError = (error: unknown): boolean => NOT_CONNECTED.test(errorText(error));
