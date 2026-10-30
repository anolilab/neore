import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readFolder, resolveShell, resolveSsh, shellEnvironment, sshEnvironment, sshTerminalAvailability, terminalAvailability } from "./shell";

const NOT_AVAILABLE = /not available/u;
const TOO_OLD = /Windows 10 version 1903/u;
const ON_WINDOWS = /Windows/u;

describe("sshTerminalAvailability", () => {
    it("is offered where the terminal is, except on Windows, which has no ssh connection sharing yet", () => {
        expect(sshTerminalAvailability("darwin")).toEqual({ available: true });
        expect(sshTerminalAvailability("linux")).toEqual({ available: true });

        const windows = sshTerminalAvailability("win32");

        expect(windows.available).toBe(false);
        expect("reason" in windows && windows.reason).toMatch(ON_WINDOWS);
    });
});

describe("terminalAvailability", () => {
    it("is offered on macOS and Linux", () => {
        expect(terminalAvailability("darwin")).toEqual({ available: true });
        expect(terminalAvailability("linux")).toEqual({ available: true });
    });

    it("is offered on Windows builds that have ConPTY", () => {
        expect(terminalAvailability("win32", "10.0.22631")).toEqual({ available: true });
        expect(terminalAvailability("win32", "10.0.18362")).toEqual({ available: true });
    });

    it("is cleanly unavailable on an older Windows, with a reason to show", () => {
        for (const release of ["10.0.17763", "6.1.7601", "", "garbage"]) {
            const windows = terminalAvailability("win32", release);

            expect(windows.available).toBe(false);
            expect("reason" in windows && windows.reason).toMatch(TOO_OLD);
        }
    });

    it("is cleanly unavailable on a platform without a pseudo-terminal, with a reason to show", () => {
        const other = terminalAvailability("freebsd");

        expect(other.available).toBe(false);
        expect("reason" in other && other.reason).toMatch(NOT_AVAILABLE);
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

    describe("on Windows", () => {
        const powershell = String.raw`D:\Win\System32\WindowsPowerShell\v1.0\powershell.exe`;
        const env = { ComSpec: String.raw`D:\Win\System32\cmd.exe`, SHELL: "/usr/bin/bash", SystemRoot: String.raw`D:\Win` };

        it("starts Windows PowerShell by absolute path, ignoring $SHELL", () => {
            expect(resolveShell(env, () => "/bin/zsh", "win32", exists(powershell, "/usr/bin/bash"))).toEqual({ args: ["-NoLogo"], file: powershell });
        });

        it("falls back to %ComSpec%, then to cmd.exe under the system folder", () => {
            expect(resolveShell(env, () => undefined, "win32", exists(env.ComSpec))).toEqual({ args: [], file: env.ComSpec });
            expect(resolveShell({ SystemRoot: env.SystemRoot }, () => undefined, "win32", exists(String.raw`D:\Win\System32\cmd.exe`)).file).toBe(String.raw`D:\Win\System32\cmd.exe`);
        });

        it("does not take a %ComSpec% that is not an absolute path to a file", () => {
            const system = String.raw`D:\Win\System32\cmd.exe`;

            expect(resolveShell({ ComSpec: "cmd.exe", SystemRoot: env.SystemRoot }, () => undefined, "win32", exists(system)).file).toBe(system);
        });

        it("does not take a %SystemRoot% that is not an absolute path", () => {
            const system = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

            expect(resolveShell({ SystemRoot: String.raw`..\Win` }, () => undefined, "win32", exists(system)).file).toBe(system);
        });

        it("fails clearly when there is no shell", () => {
            expect(() => resolveShell(env, () => undefined, "win32", exists())).toThrow("no shell was found");
        });
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

// POSIX only: a terminal on a server is not offered on Windows (`sshTerminalAvailability`).
describe.skipIf(process.platform === "win32")("resolveSsh", () => {
    const exists = (...files: string[]) => (file: string) => files.includes(file);

    it("is the first ssh on the path, as an absolute path", () => {
        expect(resolveSsh({ PATH: "/opt/bin:/usr/bin" }, exists("/usr/bin/ssh", "/opt/bin/ssh"))).toBe("/opt/bin/ssh");
    });

    it("looks in the system folders when the app was started with a thin path", () => {
        expect(resolveSsh({ PATH: "" }, exists("/usr/bin/ssh"))).toBe("/usr/bin/ssh");
        expect(resolveSsh({}, exists("/usr/bin/ssh"))).toBe("/usr/bin/ssh");
    });

    it("never takes a relative entry of the path", () => {
        expect(() => resolveSsh({ PATH: "bin:." }, (file) => file === "bin/ssh" || file === "ssh")).toThrow("ssh was not found");
    });

    it("fails clearly when there is no ssh", () => {
        expect(() => resolveSsh({ PATH: "/usr/bin" }, exists())).toThrow("ssh was not found");
    });
});

// POSIX only: a terminal on a server is not offered on Windows (`sshTerminalAvailability`).
describe.skipIf(process.platform === "win32")("sshEnvironment", () => {
    it("hands ssh where things are, who is asking, the agent and the locale, and nothing else", () => {
        const env = sshEnvironment({
            AWS_SECRET_ACCESS_KEY: "secret",
            ELECTRON_RUN_AS_NODE: "1",
            HOME: "/home/me",
            LANG: "de_DE.UTF-8",
            LC_ALL: "de_DE.UTF-8",
            NEORE_SITE_URL: "https://neore.example",
            PATH: "/usr/bin",
            SSH_ASKPASS: "/opt/askpass",
            SSH_AUTH_SOCK: "/run/user/1000/agent",
            TERM: "dumb",
            USER: "me",
        });

        expect(env).toEqual({
            HOME: "/home/me",
            LANG: "de_DE.UTF-8",
            LC_ALL: "de_DE.UTF-8",
            PATH: "/usr/bin",
            TERM: "xterm-256color",
            USER: "me",
        });
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
        // A junction needs no privilege on Windows, where a directory symlink does; elsewhere the type is ignored.
        symlinkSync(target, link, "junction");

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
