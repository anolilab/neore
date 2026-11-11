/**
 * The shapes of the "Add project" machine picker on the desktop bridge (`neoreNative.device`). Types only, so the
 * web app can import this file without pulling any desktop code.
 */

export type MachineKind = "server" | "this-computer";

export type MachineStatus = "connected" | "disabled" | "not-connected" | "this-computer" | "unpaired";

/** How to reach an ssh host that is not paired yet: what the pairing needs. */
export interface MachineServerSpec {
    address: string;
    /** The key file the config names, absolute; null when the agent and default keys are used. */
    identityFile: string | null;
    name: string;
    port: number;
    user: string;
}

/** One row of "Where is the project?". */
export interface AddProjectMachine {
    /** Why the row cannot be picked; null when it can. */
    disabledReason: string | null;
    /** The device id: this computer's own, or the paired server's. Null for an ssh host not paired with this computer yet. */
    id: string | null;
    kind: MachineKind;
    /** "This computer", "Connected", or "SSH · &lt;alias&gt; · not connected yet". */
    label: string;
    name: string;
    /** What pairing the ssh host needs; set only for an ssh host that is not paired yet. */
    spec: MachineServerSpec | null;
    /** The `Host` alias in ~/.ssh/config; null for this computer. */
    sshAlias: string | null;
    status: MachineStatus;
}

export interface MachineFolderEntry {
    name: string;
}

/** One page of the folders inside a folder. Directory names only. */
export interface MachineFolderPage {
    entries: MachineFolderEntry[];
    /** The machine's name. */
    host: string;
    /** Pass as `after` for the page that follows; null on the last. */
    next: string | null;
    /** The folder that was listed, resolved. */
    parent: string | null;
    path: string;
}

export interface BrowseMachineFolders {
    /** The previous page's `next`. */
    after?: string;
    machineId: string;
    /** An absolute path; empty starts at the home folder (this computer) or the server's first shared folder. */
    path: string;
}

export interface MachineFolderRequest {
    machineId: string;
    /** An absolute path. */
    path: string;
}

export interface CreatedMachineFolder {
    created: boolean;
    path: string;
}

export interface SharedMachineFolder {
    /** The folder as the server resolves it (symlinks followed); the one that is shared. */
    path: string;
    /** False when the folder is already shared, or on this computer. */
    shared: boolean;
}

/** What the page can call: the methods of `neoreNative.device` for the machine picker. */
export interface AddProjectMachinesBridge {
    browseMachineFolders: (request: BrowseMachineFolders) => Promise<MachineFolderPage>;
    connectAddProjectMachine: (sshAlias: string) => Promise<AddProjectMachine>;
    createMachineFolder: (request: MachineFolderRequest) => Promise<CreatedMachineFolder>;
    listAddProjectMachines: () => Promise<AddProjectMachine[]>;
    shareMachineFolder: (request: MachineFolderRequest) => Promise<SharedMachineFolder>;
}
