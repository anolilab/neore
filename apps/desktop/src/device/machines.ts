/**
 * The machines the "Add project" dialog offers: this computer, and the ssh hosts of ~/.ssh/config. The page asks;
 * a connection, a new folder on a server and a new shared folder each need a native confirmation worded here, so
 * a page cannot open or change anything on a server by itself. Arguments are validated by the caller (`validate.ts`)
 * and the machine ids and aliases are checked here against what this process knows.
 */
import type { Dirent, Stats } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { AddProjectMachine, CreatedMachineFolder, MachineFolderPage, SharedMachineFolder } from "../add-project-machines.types";
import type { SshHost } from "./ssh-config";
import type { BrowsePage, CreatedFolder, DeviceStatus, HostSpec, HostView, SettingsView } from "./types";

/** The same page size and scan cap as the host's `browse`. */
const PAGE_ENTRIES = 2000;
const MAX_SCAN = 1_000_000;

export interface MachineDependencies {
    /** A native dialog; resolves true only for the person's OK. */
    confirm: (question: { detail: string; message: string }) => Promise<boolean>;
    home: () => string;
    hostBrowse: (deviceId: string, folder: string, after?: string) => Promise<BrowsePage>;
    hostConnect: (deviceId: string) => Promise<unknown>;
    hostMakeDir: (deviceId: string, folder: string) => Promise<CreatedFolder>;
    hostProbe: (spec: HostSpec) => Promise<unknown>;
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

const declined = (): Error => new Error("device: the person declined");

const requireConnected = (host: HostView): HostView => {
    if (!host.connected) {
        throw new Error("device: connect the server first");
    }

    return host;
};

/** Directory names of a folder on this computer; a symlink is neither a directory nor a file here, as on a server. */
const browseLocal = async (requested: string, after?: string): Promise<MachineFolderPage> => {
    let folder: string;
    let entries: Dirent[];

    try {
        folder = await realpath(requested);
    } catch {
        throw new Error("device: that folder was not found");
    }

    try {
        entries = await readdir(folder, { withFileTypes: true });
    } catch {
        throw new Error("device: that folder cannot be read");
    }

    if (entries.length > MAX_SCAN) {
        throw new Error("device: too many entries to browse");
    }

    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    // `names` is a copy; the tsconfig lib has no `toSorted`.
    names.sort((left, right) => (left < right ? -1 : Number(left > right)));
    const start = after === undefined ? 0 : names.findIndex((name) => name > after);
    const rest = start === -1 ? [] : names.slice(start);
    const page = rest.slice(0, PAGE_ENTRIES);
    const parent = path.dirname(folder);

    return {
        entries: page.map((name) => {
            return { name };
        }),
        host: "This computer",
        next: rest.length > page.length ? (page.at(-1) ?? null) : null,
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

    const machineFor = (machineId: string): Machine => {
        if (dependencies.status().deviceId === machineId) {
            return { kind: "this-computer" };
        }

        const host = dependencies.settings().hosts.find((candidate) => candidate.deviceId === machineId);

        if (host === undefined) {
            throw new Error("device: unknown machine");
        }

        return { host, kind: "server" };
    };

    /** The paired server an ssh host stands for: same address, port and, when the config names one, user. */
    const pairedFor = (entry: SshHost): HostView | undefined =>
        dependencies
            .settings()
            .hosts.find((host) => host.address === (entry.hostName ?? entry.alias) && host.port === (entry.port ?? 22) && (entry.user === null || host.user === entry.user));

    const rowFor = (entry: SshHost): AddProjectMachine => {
        const base = { kind: "server" as const, name: entry.alias, sshAlias: entry.alias };

        if (entry.disabledReason !== null) {
            return { ...base, disabledReason: entry.disabledReason, id: null, label: `SSH · ${entry.alias}`, status: "disabled" };
        }

        const paired = pairedFor(entry);
        const waiting = `SSH · ${entry.alias} · not connected yet`;

        if (paired === undefined) {
            return {
                ...base,
                disabledReason: "Pair this server in the desktop's device window first.",
                id: null,
                label: waiting,
                status: "unpaired",
            };
        }

        return paired.connected
            ? { ...base, disabledReason: null, id: paired.deviceId, label: "Connected", status: "connected" }
            : { ...base, disabledReason: null, id: paired.deviceId, label: waiting, status: "not-connected" };
    };

    const list = (): AddProjectMachine[] => {
        const own = dependencies.status().deviceId;
        const computer: AddProjectMachine = {
            disabledReason: own === null ? "Pair this computer with your account first (Settings → Devices)." : null,
            id: own,
            kind: "this-computer",
            label: "This computer",
            name: "This computer",
            sshAlias: null,
            status: own === null ? "disabled" : "this-computer",
        };

        return [computer, ...dependencies.sshHosts().map((entry) => rowFor(entry))];
    };

    const connect = async (sshAlias: string): Promise<AddProjectMachine> => {
        const entry = entryFor(sshAlias);
        const paired = pairedFor(entry);

        if (paired === undefined) {
            // Not paired with the backend yet: connecting asks to trust its key and for a passphrase, in the local window.
            await dependencies.hostProbe({
                address: entry.hostName ?? entry.alias,
                name: entry.alias,
                port: entry.port ?? 22,
                user: entry.user ?? dependencies.username(),
                ...entry.identityFile !== null && { identityFile: entry.identityFile },
            });
        } else if (!paired.connected) {
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

        return dependencies.hostMakeDir(host.deviceId, folder);
    };

    const shareFolder = async (machineId: string, folder: string): Promise<SharedMachineFolder> => {
        const machine = machineFor(machineId);

        if (machine.kind === "this-computer") {
            return { shared: false };
        }

        if (machine.host.roots.some((root) => isInside(folder, root))) {
            throw new Error("device: that folder is already shared");
        }

        if (
            !await ask({
                detail: `Folder: ${JSON.stringify(folder)}\nIts coding agents and tools can then read and change files in it.`,
                message: `Share a folder on the server “${machine.host.name}” with Neore?`,
            })
        ) {
            throw declined();
        }

        // The settings may have changed while the dialog was open.
        const latest = machineFor(machineId);

        if (latest.kind !== "server" || latest.host.roots.some((root) => isInside(folder, root))) {
            throw new Error("device: that folder is already shared");
        }

        dependencies.setRoots(latest.host.deviceId, [...latest.host.roots, folder]);

        return { shared: true };
    };

    return { browse, connect, createFolder, list, shareFolder };
};
