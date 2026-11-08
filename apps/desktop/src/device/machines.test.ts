import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MachineDependencies } from "./machines";
import { createAddProjectMachines } from "./machines";
import type { SshHost } from "./ssh-config";
import type { HostView } from "./types";
import { readMachineId, readMachinePath, readSshAlias } from "./validate";

let root: string;

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "neore-machines-"));
});

afterEach(() => {
    rmSync(root, { force: true, recursive: true });
});

const ssh = (alias: string, extra: Partial<SshHost> = {}): SshHost => {
    return { alias, disabledReason: null, hostName: `${alias}.example.com`, identityFile: null, port: null, user: "deploy", ...extra };
};

const server = (extra: Partial<HostView> = {}): HostView => ({
        address: "build.example.com",
        connected: true,
        deviceId: "srv-1",
        name: "build",
        port: 22,
        roots: ["/srv/app"],
        user: "deploy",
        ...extra,
    } as HostView);

const setup = (options: { answer?: boolean; deviceId?: string | null; hosts?: HostView[]; ssh?: SshHost[] } = {}) => {
    const state = { hosts: options.hosts ?? [server()] };
    const dependencies = {
        confirm: vi.fn(async () => options.answer ?? true),
        home: () => root,
        hostBrowse: vi.fn(async (_id: string, folder: string) => {
            return { entries: [{ name: "app" }], host: "build", next: null, parent: "/", path: folder };
        }),
        hostConnect: vi.fn(async () => { return {}; }),
        hostMakeDir: vi.fn(async (_id: string, folder: string) => {
            return { created: true, path: folder };
        }),
        hostProbe: vi.fn(async () => { return {}; }),
        setRoots: vi.fn(),
        settings: () => ({ hosts: state.hosts }) as never,
        sshHosts: () => options.ssh ?? [ssh("build")],
        status: () => ({ deviceId: options.deviceId === undefined ? "desk-1" : options.deviceId, hosts: [] }) as never,
        username: () => "me",
    } satisfies MachineDependencies;

    return { deps: dependencies, machines: createAddProjectMachines(dependencies), state };
};

describe("list", () => {
    it("starts with this computer, then the ssh hosts with their status", () => {
        const { machines } = setup({ ssh: [ssh("build"), ssh("new", { port: 2200 }), ssh("jump", { disabledReason: "uses ProxyJump" })] });
        const rows = machines.list();

        expect(rows.map((row) => [row.name, row.status, row.label])).toEqual([
            ["This computer", "this-computer", "This computer"],
            ["build", "connected", "Connected"],
            ["new", "unpaired", "SSH · new · not connected yet"],
            ["jump", "disabled", "SSH · jump"],
        ]);
        expect(rows[0]?.id).toBe("desk-1");
        expect(rows[1]?.id).toBe("srv-1");
        expect(rows[3]?.disabledReason).toBe("uses ProxyJump");
    });

    it("disables this computer, with a reason, when it is not paired", () => {
        const [first] = setup({ deviceId: null }).machines.list();

        expect(first).toMatchObject({ id: null, status: "disabled" });
        expect(first?.disabledReason).toContain("Pair");
    });

    it("says not connected for a paired server that is down", () => {
        const rows = setup({ hosts: [server({ connected: false })] }).machines.list();

        expect(rows[1]).toMatchObject({ label: "SSH · build · not connected yet", status: "not-connected" });
    });
});

describe("connect", () => {
    it("connects a paired server that is down", async () => {
        const { deps, machines, state } = setup({ hosts: [server({ connected: false })] });

        deps.hostConnect.mockImplementation(async () => {
            state.hosts = [server()];

            return {};
        });

        await expect(machines.connect("build")).resolves.toMatchObject({ status: "connected" });
        expect(deps.hostConnect).toHaveBeenCalledWith("srv-1");
    });

    it("passes HostName, User, Port and IdentityFile explicitly for a host that is not paired", async () => {
        const { deps, machines } = setup({ hosts: [], ssh: [ssh("box", { identityFile: "/k/id", port: 2222 })] });

        await expect(machines.connect("box")).resolves.toMatchObject({ status: "unpaired" });
        expect(deps.hostProbe).toHaveBeenCalledWith({ address: "box.example.com", identityFile: "/k/id", name: "box", port: 2222, user: "deploy" });
    });

    it("uses the local user and port 22 when the config names neither", async () => {
        const { deps, machines } = setup({ hosts: [], ssh: [ssh("box", { hostName: null, user: null })] });

        await machines.connect("box");

        expect(deps.hostProbe).toHaveBeenCalledWith({ address: "box", name: "box", port: 22, user: "me" });
    });

    it("refuses an alias the reader did not return and a disabled host, connecting nothing", async () => {
        const { deps, machines } = setup({ ssh: [ssh("jump", { disabledReason: "uses ProxyJump" })] });

        await expect(machines.connect("other")).rejects.toThrow("not in ~/.ssh/config");
        await expect(machines.connect("jump")).rejects.toThrow("uses ProxyJump");
        expect(deps.hostProbe).not.toHaveBeenCalled();
        expect(deps.hostConnect).not.toHaveBeenCalled();
    });
});

describe("browse", () => {
    it("lists directories of this computer only, skipping files and symlinks, sorted", async () => {
        mkdirSync(path.join(root, "b"));
        mkdirSync(path.join(root, "a"));
        writeFileSync(path.join(root, "file.txt"), "x");
        symlinkSync(path.join(root, "a"), path.join(root, "link"));

        const page = await setup().machines.browse("desk-1", root);

        expect(page.entries).toEqual([{ name: "a" }, { name: "b" }]);
        expect(page.next).toBeNull();
        expect(page.parent).toBe(path.dirname(page.path));
    });

    it("starts at the home folder for an empty path and pages by name", async () => {
        for (let index = 0; index < 2003; index += 1) {
            mkdirSync(path.join(root, `d${String(index).padStart(4, "0")}`));
        }

        const { machines } = setup();
        const first = await machines.browse("desk-1", "");

        expect(first.entries).toHaveLength(2000);
        expect(first.next).toBe("d1999");

        const second = await machines.browse("desk-1", "", first.next ?? undefined);

        expect(second.entries.map((entry) => entry.name)).toEqual(["d2000", "d2001", "d2002"]);
        expect(second.next).toBeNull();
    });

    it("refuses a missing folder and a file", async () => {
        writeFileSync(path.join(root, "f"), "x");
        const { machines } = setup();

        await expect(machines.browse("desk-1", path.join(root, "nope"))).rejects.toThrow("not found");
        await expect(machines.browse("desk-1", path.join(root, "f"))).rejects.toThrow("cannot be read");
    });

    it("asks a connected server through the host, and refuses one that is not connected", async () => {
        const { deps, machines, state } = setup();

        await machines.browse("srv-1", "/srv/app", "m");
        expect(deps.hostBrowse).toHaveBeenCalledWith("srv-1", "/srv/app", "m");

        await machines.browse("srv-1", "");
        expect(deps.hostBrowse).toHaveBeenLastCalledWith("srv-1", "/srv/app", undefined);

        state.hosts = [server({ connected: false })];
        await expect(machines.browse("srv-1", "/srv")).rejects.toThrow("connect the server first");
    });

    it("refuses a machine this process does not know", async () => {
        const { deps, machines } = setup();

        await expect(machines.browse("srv-other", "/")).rejects.toThrow("unknown machine");
        expect(deps.hostBrowse).not.toHaveBeenCalled();
    });
});

describe("createFolder", () => {
    it("makes a folder on this computer without a prompt, and refuses a file", async () => {
        const { deps, machines } = setup();
        const target = path.join(root, "x", "y");

        await expect(machines.createFolder("desk-1", target)).resolves.toMatchObject({ created: true });
        await expect(machines.createFolder("desk-1", target)).resolves.toMatchObject({ created: false });
        writeFileSync(path.join(root, "f"), "x");
        await expect(machines.createFolder("desk-1", path.join(root, "f"))).rejects.toThrow("is a file");
        expect(deps.confirm).not.toHaveBeenCalled();
    });

    it("confirms by naming the server and the path, then makes the folder on the server", async () => {
        const { deps, machines } = setup();

        await machines.createFolder("srv-1", "/srv/new");

        expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("/srv/new"), message: expect.stringContaining("build") }));
        expect(deps.hostMakeDir).toHaveBeenCalledWith("srv-1", "/srv/new");
    });

    it("does nothing on a server when the confirmation is declined", async () => {
        const { deps, machines } = setup({ answer: false });

        await expect(machines.createFolder("srv-1", "/srv/new")).rejects.toThrow("declined");
        expect(deps.hostMakeDir).not.toHaveBeenCalled();
    });

    it("refuses a second confirmation while one is open", async () => {
        const { deps, machines } = setup();
        let release: (answer: boolean) => void = () => {};

        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- Promise.withResolvers needs Node 22.11
        const held = new Promise<boolean>((resolve) => {
            release = resolve;
        });

        deps.confirm.mockImplementationOnce(() => held);

        const first = machines.createFolder("srv-1", "/srv/a");

        await expect(machines.createFolder("srv-1", "/srv/b")).rejects.toThrow("another confirmation");
        release(false);
        await expect(first).rejects.toThrow("declined");
        expect(deps.hostMakeDir).not.toHaveBeenCalled();
    });
});

describe("shareFolder", () => {
    it("adds the folder to the server's shared folders after a confirmation naming both", async () => {
        const { deps, machines } = setup();

        await expect(machines.shareFolder("srv-1", "/data/proj")).resolves.toEqual({ shared: true });

        expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("/data/proj"), message: expect.stringContaining("build") }));
        expect(deps.setRoots).toHaveBeenCalledWith("srv-1", ["/srv/app", "/data/proj"]);
    });

    it("changes nothing when the confirmation is declined", async () => {
        const { deps, machines } = setup({ answer: false });

        await expect(machines.shareFolder("srv-1", "/data/proj")).rejects.toThrow("declined");
        expect(deps.setRoots).not.toHaveBeenCalled();
    });

    it("refuses a folder that is already shared or inside a shared folder, without asking", async () => {
        const { deps, machines } = setup();

        await expect(machines.shareFolder("srv-1", "/srv/app")).rejects.toThrow("already shared");
        await expect(machines.shareFolder("srv-1", "/srv/app/sub")).rejects.toThrow("already shared");
        await expect(machines.shareFolder("srv-1", "/srv/application")).resolves.toEqual({ shared: true });
        expect(deps.confirm).toHaveBeenCalledTimes(1);
    });

    it("is a no-op for this computer", async () => {
        const { deps, machines } = setup();

        await expect(machines.shareFolder("desk-1", root)).resolves.toEqual({ shared: false });
        expect(deps.confirm).not.toHaveBeenCalled();
        expect(deps.setRoots).not.toHaveBeenCalled();
    });
});

describe("validators", () => {
    it("accept an absolute path and refuse the rest", () => {
        expect(readMachinePath("/srv/app", false)).toBe("/srv/app");
        expect(readMachinePath("", true, true)).toBe("");
        expect(() => readMachinePath("", true)).toThrow("device: path is invalid");
        expect(() => readMachinePath("srv/app", false)).toThrow("must be absolute");
        expect(() => readMachinePath("../x", true)).toThrow("must be absolute");
        expect(() => readMachinePath("/a\0b", false)).toThrow("device: path is invalid");
        expect(() => readMachinePath(`/${"a".repeat(1024)}`, false)).toThrow("device: path is invalid");
        expect(() => readMachinePath(`/${"é".repeat(600)}`, false)).toThrow("device: path is invalid");
        expect(() => readMachinePath(7, false)).toThrow("device: path is invalid");
    });

    it("refuse a machine id or alias of the wrong shape", () => {
        expect(readMachineId("srv-1")).toBe("srv-1");
        expect(() => readMachineId("")).toThrow("machineId is invalid");
        expect(() => readMachineId({})).toThrow("machineId is invalid");
        expect(readSshAlias("build-box")).toBe("build-box");
        expect(() => readSshAlias("a b")).toThrow("sshAlias is invalid");
        expect(() => readSshAlias("web-*")).toThrow("sshAlias is invalid");
        expect(() => readSshAlias(3)).toThrow("sshAlias is invalid");
    });
});
