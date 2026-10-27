import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readFolder, resolveShell, shellEnvironment, terminalAvailability } from "./shell";

const NOT_AVAILABLE = /not available/u;

describe("terminalAvailability", () => {
    it("is offered on macOS and Linux", () => {
        expect(terminalAvailability("darwin")).toEqual({ available: true });
        expect(terminalAvailability("linux")).toEqual({ available: true });
    });

    it("is cleanly unavailable on Windows, with a reason to show", () => {
        const windows = terminalAvailability("win32");

        expect(windows.available).toBe(false);
        expect("reason" in windows && windows.reason).toMatch(NOT_AVAILABLE);
    });
});

describe("resolveShell", () => {
    const exists = (...files: string[]) => (file: string) => files.includes(file);

    it("starts the user's $SHELL as a login shell", () => {
        expect(resolveShell({ SHELL: "/usr/bin/fish" }, () => "/bin/bash", "linux", exists("/usr/bin/fish"))).toEqual({ args: ["-l"], file: "/usr/bin/fish" });
    });

    it("falls back to the account's shell, then the platform default", () => {
        expect(resolveShell({}, () => "/bin/bash", "linux", exists("/bin/bash"))).toEqual({ args: ["-l"], file: "/bin/bash" });
        expect(resolveShell({}, () => undefined, "darwin", exists("/bin/zsh")).file).toBe("/bin/zsh");
    });

    it("ignores a $SHELL that is not an absolute path to an executable", () => {
        expect(resolveShell({ SHELL: "zsh" }, () => undefined, "linux", exists("/bin/sh")).file).toBe("/bin/sh");
        expect(resolveShell({ SHELL: "/not/there" }, () => undefined, "linux", exists("/bin/sh")).file).toBe("/bin/sh");
    });

    it("fails clearly when no shell exists", () => {
        expect(() => resolveShell({}, () => undefined, "linux", exists())).toThrow("no shell was found");
    });
});

describe("shellEnvironment", () => {
    it("keeps the user's environment and drops what only the app runs under", () => {
        const env = shellEnvironment({
            ELECTRON_RUN_AS_NODE: "1",
            HOME: "/home/me",
            NEORE_SITE_URL: "https://neore.example",
            NODE_OPTIONS: "--inspect",
            PATH: "/usr/bin",
            TERM: "dumb",
        });

        expect(env).toEqual({ COLORTERM: "truecolor", HOME: "/home/me", PATH: "/usr/bin", TERM: "xterm-256color" });
    });

    it("gives the shell the user's own desktop name back", () => {
        const env = shellEnvironment({ ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME", XDG_CURRENT_DESKTOP: "Unity" });

        expect(env.XDG_CURRENT_DESKTOP).toBe("GNOME");
        expect(env).not.toHaveProperty("ORIGINAL_XDG_CURRENT_DESKTOP");
        expect(shellEnvironment({ XDG_CURRENT_DESKTOP: "KDE" }).XDG_CURRENT_DESKTOP).toBe("KDE");
    });
});

describe("readFolder", () => {
    // The temporary directory is itself behind a link on macOS (`/var` → `/private/var`).
    const created = mkdtempSync(path.join(tmpdir(), "neore-folder-"));
    const directory = realpathSync(created);

    it("accepts an existing directory", () => {
        expect(readFolder(directory)).toBe(directory);
    });

    it("names one folder however it is spelled: a trailing slash, a link, a `..` through a link", () => {
        const target = path.join(directory, "real");
        const link = path.join(directory, "link");

        mkdirSync(target);
        symlinkSync(target, link);

        expect(readFolder(`${target}/`)).toBe(target);
        expect(readFolder(link)).toBe(target);
        expect(readFolder(path.join(link, ".."))).toBe(directory);
    });

    it("refuses a missing path, a file, a relative path and a non-string", () => {
        const file = path.join(directory, "file.txt");

        writeFileSync(file, "x");
        mkdirSync(path.join(directory, "sub"));

        expect(() => readFolder(path.join(directory, "missing"))).toThrow("does not exist");
        expect(() => readFolder(file)).toThrow("does not exist");
        expect(() => readFolder("relative/path")).toThrow("invalid");
        expect(() => readFolder(7)).toThrow("invalid");
        expect(() => readFolder("")).toThrow("invalid");
    });
});
