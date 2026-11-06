import { describe, expect, it, vi } from "vitest";

import { createRequestOf, SessionTerminals, shellQuote, shownLine, terminalLine } from "./terminals";

describe(shellQuote, () => {
    it("leaves a plain word bare and quotes anything the shell would read differently", () => {
        expect(shellQuote("src/a.ts")).toBe("src/a.ts");
        expect(shellQuote("two words")).toBe("'two words'");
        expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
        expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`);
        expect(shellQuote("")).toBe("''");
    });
});

describe("the line a terminal runs", () => {
    it("keeps the command as sent and quotes each argument after it", () => {
        expect(terminalLine("npm run", ["test", "--", "a b"])).toBe("npm run test -- 'a b'");
    });

    it("shows the variables the agent sets in front of it", () => {
        expect(shownLine("make", [["CI", "1"], ["MSG", "a b"]])).toBe("env CI=1 MSG='a b' sh -c make");
        expect(shownLine("make", [])).toBe("make");
        // Set for the whole run: a compound line shows the variables on the shell, not on its first command alone.
        expect(shownLine("true; git push", [["PATH", "/shared/bin"]])).toBe("env PATH=/shared/bin sh -c 'true; git push'");
    });
});

describe(createRequestOf, () => {
    it("reads a request whole", () => {
        expect(createRequestOf({ args: ["x"], command: " ls ", cwd: "/work", env: [{ name: "A", value: "1" }], outputByteLimit: 500 })).toEqual({
            cwd: "/work",
            env: [["A", "1"]],
            line: "ls x",
            outputByteLimit: 500,
            shown: "env A=1 sh -c 'ls x'",
        });
    });

    it("refuses what it cannot run as asked", () => {
        for (const params of [
            {},
            { command: "  " },
            { args: [1], command: "ls" },
            { command: "ls", cwd: "relative" },
            { command: "ls", env: [{ name: "1BAD", value: "x" }] },
            { command: "ls", env: [{ name: "A", value: "a\0b" }] },
            // A bidi override or a zero-width joiner would show a different command than the one that runs.
            { command: "echo\u{202E}eil" },
            { command: "ls\u{200D}x" },
            { command: "ls", cwd: "/work\u{2066}x" },
            // A line break in a command is how a heredoc reads; the terminal runs it as the agent wrote it.
            // Names the core refuses after the approval, and a value over its size: refused before anyone is asked.
            { command: "ls", env: [{ name: "NEORE_TOKEN", value: "x" }] },
            { command: "ls", env: [{ name: "electron_run_as_node", value: "1" }] },
            { command: "ls", env: [{ name: "NODE_OPTIONS", value: "--require x" }] },
            { command: "ls", env: [{ name: "BIG", value: "v".repeat(8193) }] },
            { command: "x".repeat(4001) },
            // The line fits, but not with the variables in front of it: the person must read whole what they allow.
            { command: "ls", env: Array.from({ length: 10 }, (_, index) => { return { name: `V${String(index)}`, value: "v".repeat(400) }; }) },
        ]) {
            expect(() => createRequestOf(params)).toThrow();
        }
    });

    it("reads a command with a line break or a tab, as the agent wrote it, and refuses a carriage return", () => {
        expect(createRequestOf({ args: ["commit", "-m", "a\nb\tc"], command: "git" }).line).toContain("\n");
        expect(() => createRequestOf({ command: "ls\rrm" })).toThrow();
    });

    it("ignores an output limit that is not a positive whole number", () => {
        expect(createRequestOf({ command: "ls", outputByteLimit: -1 })).not.toHaveProperty("outputByteLimit");
    });
});

const AT_MOST = /at most/;
const ENDED = /ended/;

describe(SessionTerminals, () => {
    const deferredHost = () => {
        const resolvers: ((handle: number) => void)[] = [];
        const release = vi.fn();
        const host = {
            kill: vi.fn(),
            output: vi.fn(),
            release,
            start: vi.fn(async () => await new Promise<number>((resolve) => { resolvers.push(resolve); })),
            wait: vi.fn(async () => await new Promise<never>(() => {})),
        };

        return { host, release, resolvers };
    };
    const request = { agentKey: "a", env: [], folder: "/w", line: "ls" } as never;

    it("kills the commands of the turn that was cancelled, and leaves an earlier turn's running", async () => {
        const { host, resolvers } = deferredHost();
        const terminals = new SessionTerminals(host as never, () => {});
        const earlier = terminals.create(request, "turn-1");
        const current = terminals.create(request, "turn-2");

        resolvers[0]?.(10);
        resolvers[1]?.(11);
        await Promise.all([earlier, current]);

        terminals.killTurn("turn-2");

        expect(host.kill).toHaveBeenCalledTimes(1);
        expect(host.kill).toHaveBeenCalledWith(11);
    });

    it("frees the slot of a command a cancelled turn killed, and keeps what it printed for its row", async () => {
        const ends = new Map<number, (exit: { exitCode: number | null; signal: string | null }) => void>();
        let next = 10;
        const host = {
            kill: vi.fn((handle: number) => {
                ends.get(handle)?.({ exitCode: null, signal: "SIGKILL" });
            }),
            output: vi.fn(() => {
                return { output: "partial", truncated: false };
            }),
            release: vi.fn(),
            start: vi.fn(async () => {
                next += 1;

                return next - 1;
            }),
            wait: vi.fn(
                async (handle: number) =>
                    await new Promise((resolve) => {
                        ends.set(handle, resolve);
                    }),
            ),
        };
        const terminals = new SessionTerminals(host as never, () => {});
        const id = await terminals.create(request, "turn-2");

        terminals.killTurn("turn-2");

        await expect.poll(() => terminals.result(id)).toBeDefined();
        expect(terminals.result(id)?.output).toBe("partial");
        expect(host.release).toHaveBeenCalledWith(10);
        expect(terminals.live).toBe(0);
    });

    it("holds a slot while a command is starting", async () => {
        const { host, resolvers } = deferredHost();
        const terminals = new SessionTerminals(host as never, () => {});
        const starts = Array.from({ length: 4 }, () => terminals.create(request));

        await expect(terminals.create(request)).rejects.toThrow(AT_MOST);

        for (const [index, resolve] of resolvers.entries()) {
            resolve(index);
        }

        await Promise.all(starts);
        expect(terminals.live).toBe(4);
    });

    it("frees a command that finished starting after the session ended", async () => {
        const { host, release, resolvers } = deferredHost();
        const terminals = new SessionTerminals(host as never, () => {});
        const start = terminals.create(request);

        terminals.releaseAll();
        resolvers[0]?.(7);

        await expect(start).rejects.toThrow(ENDED);
        expect(release).toHaveBeenCalledWith(7);
        expect(terminals.live).toBe(0);
    });

    it("waits on the core once per command, however often the agent asks for its exit", async () => {
        const exit = { exitCode: 3, signal: null };
        const finishes: ((status: typeof exit) => void)[] = [];
        const host = {
            kill: vi.fn(),
            output: vi.fn(),
            release: vi.fn(),
            start: vi.fn(async () => 5),
            wait: vi.fn(
                async () =>
                    await new Promise<typeof exit>((resolve) => {
                        finishes.push(resolve);
                    }),
            ),
        };
        const terminals = new SessionTerminals(host as never, () => {});
        const id = await terminals.create(request);
        // Asked while the command still runs: each ask must share the one wait the terminal already has in the core.
        const asks = [terminals.waitForExit(id), terminals.waitForExit(id), terminals.waitForExit(id)];

        finishes[0]?.(exit);

        await expect(Promise.all(asks)).resolves.toEqual([exit, exit, exit]);
        expect(host.wait).toHaveBeenCalledTimes(1);
    });

});
