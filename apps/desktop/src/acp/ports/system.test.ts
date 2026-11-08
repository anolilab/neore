import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => {
    return { execFile: vi.fn() };
});

vi.mock("node:child_process", async () => {
    return { ...await vi.importActual<typeof import("node:child_process")>("node:child_process"), execFile };
});
vi.mock("node:fs", async () => {
    return { ...await vi.importActual<typeof import("node:fs")>("node:fs"), existsSync: (path: string) => path === "/usr/sbin/lsof" };
});

const { realPortsSystem } = await import("./system");

type Callback = (error: unknown, stdout: string, stderr: string) => void;

const answer = (error: unknown, stdout: string, stderr: string): void => {
    execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Callback) => {
        callback(error, stdout, stderr);
    });
};

const exitOne = (): Error => Object.assign(new Error("exit 1"), { code: 1 });

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("lsof exit code 1", () => {
    beforeEach(() => {
        execFile.mockReset();
    });

    it("keeps the sockets it printed when only a requested pid was gone", async () => {
        answer(exitOne(), "p30\nn*:3000\n", "");

        expect(await realPortsSystem.listeners([30, 99])).toEqual([{ address: "*", pid: 30, port: 3000 }]);
    });

    it("is an empty answer when the only output is lsof's own warning, as on Linux with a fuse mount", async () => {
        answer(exitOne(), "", "lsof: WARNING: can't stat() fuse.gvfsd-fuse file system /run/user/1000/gvfs\n      Output information may be incomplete.\n");

        expect(await realPortsSystem.listeners([30])).toEqual([]);
    });

    it("is a failed read, not an empty answer, when lsof reports a real error", async () => {
        answer(exitOne(), "", "lsof: illegal option -- x");

        await expect(realPortsSystem.listeners([30])).rejects.toThrow();
    });
});
