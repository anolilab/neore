/**
 * The machines the "Add project" dialog offers: this computer, and the ssh hosts of ~/.ssh/config. The page asks;
 * a connection, a new folder on a server and a new shared folder each need a native confirmation worded here, so
 * a page cannot open or change anything on a server by itself. Arguments are validated by the caller (`validate.ts`)
 * and the machine ids and aliases are checked here against what this process knows.
 */
import type { Stats } from "node:fs";
import { mkdir, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { AddProjectMachine, CreatedMachineFolder, MachineFolderPage, MachineServerSpec, SharedMachineFolder } from "../add-project-machines.types";
import type { SshHost } from "./ssh-config";
import type { BrowsePage, CreatedFolder, DeviceStatus, HostView, SettingsView } from "./types";

/** The same page size and scan cap as the host's `browse`. */
const PAGE_ENTRIES = 2000;
const MAX_SCAN = 1_000_000;
/** The most shared folders one server may have. Must match MAX_ROOTS in the host (`packages/device-core`). */
const MAX_SERVER_ROOTS = 20;

export interface MachineDependencies {
    /** A native dialog; resolves true only for the person's OK. */
    confirm: (question: { detail: string; message: string }) => Promise<boolean>;
    home: () => string;
    hostBrowse: (deviceId: string, folder: string, after?: string) => Promise<BrowsePage>;
    hostConnect: (deviceId: string) => Promise<unknown>;
    hostMakeDir: (deviceId: string, folder: string) => Promise<CreatedFolder>;
    /** Replaces one server's shared folders. */
    setRoots: (deviceId: string, roots: string[]) => void;
    settings: () => SettingsView;
    sshHosts: () => SshHost[];
    status: () => DeviceStatus;
    username: () => string;
}

export interface AddProjectMachines {
    browse: (machineId: string, folder: string, after?: string) => Promise<MachineFolderPage>;
    connect: (sshAlias: string) => Promise<AddProjectMachine>;
    createFolder: (machineId: string, folder: string) => Promise<CreatedMachineFolder>;
    list: () => AddProjectMachine[];
    shareFolder: (machineId: string, folder: string) => Promise<SharedMachineFolder>;
}

type Machine = { host: HostView; kind: "server" } | { kind: "this-computer" };

const isInside = (folder: string, root: string): boolean => folder === root || folder.startsWith(root.endsWith("/") ? root : `${root}/`);

const statOrNull = async (file: string): Promise<Stats | null> => {
    try {
        return await stat(file);
    } catch {
        return null;
    }
};

const rootLimit = (): string => `device: this server already has ${MAX_SERVER_ROOTS} shared folders; share a parent folder or remove one in the desktop app.`;

const declined = (): Error => new Error("device: the person declined");

const requireConnected = (host: HostView): HostView => {
    if (!host.connected) {
        throw new Error("device: connect the server first");
    }

    return host;
};

const compareNames = (left: string, right: string): number => (left < right ? -1 : Number(left > right));

/** Puts a name into a sorted list at its place and drops the largest when the list grows past `size`. */
const insertSmallest = (sorted: string[], name: string, size: number): void => {
    let low = 0;
    let high = sorted.length;

    while (low < high) {
        const middle = Math.floor((low + high) / 2);

        if (compareNames(sorted[middle] as string, name) < 0) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    if (low >= size) {
        return;
    }

    sorted.splice(low, 0, name);

    if (sorted.length > size) {
        sorted.pop();
    }
};

/** Directory names of a folder on this computer; a symlink is neither a directory nor a file here, as on a server. */
const browseLocal = async (requested: string, after?: string): Promise<MachineFolderPage> => {
    let folder: string;

    try {
        folder = await realpath(requested);
    } catch {
        throw new Error("device: that folder was not found");
    }

    // Only the page and one more name are kept, so a folder of a million entries costs one page of memory.
    const kept: string[] = [];
    let scanned = 0;

    try {
        const directory = await opendir(folder);

        for await (const entry of directory) {
            scanned += 1;

            if (scanned > MAX_SCAN) {
                throw new Error("device: too many entries to browse");
            }

            if (entry.isDirectory() && (after === undefined || entry.name > after)) {
                insertSmallest(kept, entry.name, PAGE_ENTRIES + 1);
            }
        }
    } catch (error) {
        if (error instanceof Error && error.message === "device: too many entries to browse") {
            throw error;
        }

        throw new Error("device: that folder cannot be read", { cause: error });
    }

    const page = kept.slice(0, PAGE_ENTRIES);
    const parent = path.dirname(folder);

    return {
        entries: page.map((name) => {
            return { name };
        }),
        host: "This computer",
        next: kept.length > page.length ? (page.at(-1) ?? null) : null,
        parent: parent === folder ? null : parent,
        path: folder,
    };
};

export const createAddProjectMachines = (dependencies: MachineDependencies): AddProjectMachines => {
    let confirming = false;

    /** One native question at a time: a page that asks again while one is open gets nothing. */
    const ask = async (question: { detail: string; message: string }): Promise<boolean> => {
        if (confirming) {
            throw new Error("device: another confirmation is open");
        }

        confirming = true;

        try {
            return await dependencies.confirm(question);
        } finally {
            confirming = false;
        }
    };

    const entryFor = (alias: string): SshHost => {
        const entry = dependencies.sshHosts().find((candidate) => candidate.alias === alias);

        if (entry === undefined) {
            throw new Error("device: that host is not in ~/.ssh/config");
        }

        if (entry.disabledReason !== null) {
            throw new Error(`device: ${entry.disabledReason}`);
        }

        return entry;
    };

    /** The paired server an ssh host stands for: same address, port and, when the config names one, user. */
    const pairedFor = (entry: SshHost): HostView | undefined =>
        dependencies
            .settings()
            .hosts.find(
                (host) =>
                    host.address === (entry.hostName ?? entry.alias) &&
                    host.port === (entry.port ?? 22) &&
                    host.user === (entry.user ?? dependencies.username()) &&
                    (entry.identityFile === null || host.identityFile === entry.identityFile),
            );

    const machineFor = (machineId: string): Machine => {
        if (dependencies.status().deviceId === machineId) {
            return { kind: "this-computer" };
        }

        const host = dependencies.settings().hosts.find((candidate) => candidate.deviceId === machineId);

        // Only a server the picker lists: some usable ssh host of the config must stand for it.
        const listed = dependencies.sshHosts().some((entry) => entry.disabledReason === null && pairedFor(entry)?.deviceId === machineId);

        if (host === undefined || !listed) {
            throw new Error("device: unknown machine");
        }

        return { host, kind: "server" };
    };

    /** A server's pairing must be the same one after a confirmation as before it. */
    const stillPaired = (machineId: string, before: HostView): HostView => {
        const latest = machineFor(machineId);

        if (latest.kind !== "server" || latest.host.deviceId !== before.deviceId || latest.host.address !== before.address || latest.host.port !== before.port || latest.host.user !== before.user) {
            throw new Error("device: the server changed while the confirmation was open; try again");
        }

        return latest.host;
    };

    /** What pairing an ssh host needs: the same address, port and user the transport would use. */
    const specFor = (entry: SshHost): MachineServerSpec => {
        return {
            address: entry.hostName ?? entry.alias,
            identityFile: entry.identityFile,
            name: entry.alias,
            port: entry.port ?? 22,
            user: entry.user ?? dependencies.username(),
        };
    };

    const rowFor = (entry: SshHost): AddProjectMachine => {
        const base = { kind: "server" as const, name: entry.alias, sshAlias: entry.alias };

        if (entry.disabledReason !== null) {
            return { ...base, disabledReason: entry.disabledReason, id: null, label: `SSH · ${entry.alias}`, spec: null, status: "disabled" };
        }

        const paired = pairedFor(entry);
        const waiting = `SSH · ${entry.alias} · not connected yet`;

        if (paired === undefined) {
            return { ...base, disabledReason: null, id: null, label: waiting, spec: specFor(entry), status: "unpaired" };
        }

        return paired.connected
            ? { ...base, disabledReason: null, id: paired.deviceId, label: "Connected", spec: null, status: "connected" }
            : { ...base, disabledReason: null, id: paired.deviceId, label: waiting, spec: null, status: "not-connected" };
    };

    const list = (): AddProjectMachine[] => {
        const own = dependencies.status().deviceId;
        const computer: AddProjectMachine = {
            disabledReason: own === null ? "Pair this computer with your account first (Settings → Devices)." : null,
            id: own,
            kind: "this-computer",
            label: "This computer",
            name: "This computer",
            spec: null,
            sshAlias: null,
            status: own === null ? "disabled" : "this-computer",
        };

        return [computer, ...dependencies.sshHosts().map((entry) => rowFor(entry))];
    };

    /** Connects a paired server again. A server that is not paired yet is paired by the page first, with the shell's prompts. */
    const connect = async (sshAlias: string): Promise<AddProjectMachine> => {
        const entry = entryFor(sshAlias);
        const paired = pairedFor(entry);

        if (paired === undefined) {
            throw new Error("device: pair this server first");
        }

        if (!paired.connected) {
            await dependencies.hostConnect(paired.deviceId);
        }

        return rowFor(entry);
    };

    const browse = async (machineId: string, folder: string, after?: string): Promise<MachineFolderPage> => {
        const machine = machineFor(machineId);

        if (machine.kind === "this-computer") {
            return browseLocal(folder === "" ? dependencies.home() : folder, after);
        }

        const host = requireConnected(machine.host);
        const page = await dependencies.hostBrowse(host.deviceId, folder === "" ? (host.roots[0] ?? "/") : folder, after);

        return {
            entries: page.entries.map((entry) => {
                return { name: entry.name };
            }),
            host: page.host,
            next: page.next,
            parent: page.parent,
            path: page.path,
        };
    };

    const createFolder = async (machineId: string, folder: string): Promise<CreatedMachineFolder> => {
        const machine = machineFor(machineId);

        if (machine.kind === "this-computer") {
            const existing = await statOrNull(folder);

            if (existing !== null && !existing.isDirectory()) {
                throw new Error("device: that path is a file");
            }

            if (existing === null && !await ask({ detail: `Folder: ${JSON.stringify(folder)}`, message: "Create a new folder on this computer?" })) {
                throw declined();
            }

            await mkdir(folder, { recursive: true });

            return { created: existing === null, path: await realpath(folder) };
        }

        const host = requireConnected(machine.host);

        if (!await ask({ detail: `Folder: ${JSON.stringify(folder)}`, message: `Create a new folder on the server “${host.name}”?` })) {
            throw declined();
        }

        return dependencies.hostMakeDir(requireConnected(stillPaired(machineId, host)).deviceId, folder);
    };

    const shareFolder = async (machineId: string, folder: string): Promise<SharedMachineFolder> => {
        const machine = machineFor(machineId);

        if (machine.kind === "this-computer") {
            return { path: folder, shared: false };
        }

        // The host resolves the folder (symlinks) and says whether it refuses it as a root; what is shown and stored is what it resolved.
        const resolved = await dependencies.hostBrowse(requireConnected(machine.host).deviceId, folder);

        if (resolved.refusedRoot) {
            throw new Error("device: that folder is the server's home folder or one above it. Choose a folder inside it.");
        }

        const target = resolved.path;

        if (machine.host.roots.some((root) => isInside(target, root))) {
            throw new Error("device: that folder is already shared");
        }

        if (machine.host.roots.length >= MAX_SERVER_ROOTS) {
            throw new Error(rootLimit());
        }

        if (
            !await ask({
                detail: `Folder: ${JSON.stringify(target)}\nIts coding agents and tools can then read and change files in it.`,
                message: `Share a folder on the server “${machine.host.name}” with Neore?`,
            })
        ) {
            throw declined();
        }

        // The settings may have changed while the dialog was open.
        const latest = stillPaired(machineId, machine.host);

        if (latest.roots.some((root) => isInside(target, root))) {
            throw new Error("device: that folder is already shared");
        }

        if (latest.roots.length >= MAX_SERVER_ROOTS) {
            throw new Error(rootLimit());
        }

        dependencies.setRoots(latest.deviceId, [...latest.roots, target]);

        return { path: target, shared: true };
    };

    return { browse, connect, createFolder, list, shareFolder };
};
