import { afterEach, describe, expect, it, vi } from "vitest";

import { hangUp } from "./hang-up";

const TASKKILL = /\/System32\/taskkill\.exe$/u;

afterEach(() => {
    vi.restoreAllMocks();
});

describe("hangUp", () => {
    it("sends SIGHUP to a POSIX shell", () => {
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
        const run = vi.fn();

        hangUp(4242, "linux", run as never);

        expect(signal).toHaveBeenCalledWith(4242, "SIGHUP");
        expect(run).not.toHaveBeenCalled();
    });

    it("ends the whole tree of a Windows shell with taskkill, by absolute path", () => {
        const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
        const run = vi.fn();

        hangUp(4242, "win32", run as never);

        expect(signal).not.toHaveBeenCalled();
        expect(run).toHaveBeenCalledTimes(1);

        const [file, args, options] = run.mock.calls[0] as [string, string[], Record<string, unknown>];

        expect(file.replaceAll("\\", "/")).toMatch(TASKKILL);
        expect(args).toEqual(["/pid", "4242", "/t", "/f"]);
        expect(options).toMatchObject({ timeout: 3000, windowsHide: true });
    });

    it("does not fail when the shell is already gone", () => {
        vi.spyOn(process, "kill").mockImplementation(() => {
            throw new Error("ESRCH");
        });

        expect(() => hangUp(1, "darwin")).not.toThrow();
        expect(() =>
            hangUp(1, "win32", (() => {
                throw new Error("not found");
            }) as never),
        ).not.toThrow();
    });
});
