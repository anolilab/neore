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
        expect(shownLine("make", [["CI", "1"], ["MSG", "a b"]])).toBe("CI=1 MSG='a b' make");
    });
});

describe(createRequestOf, () => {
    it("reads a request whole", () => {
        expect(createRequestOf({ args: ["x"], command: " ls ", cwd: "/work", env: [{ name: "A", value: "1" }], outputByteLimit: 500 })).toEqual({
            cwd: "/work",
            env: [["A", "1"]],
            line: "ls x",
            outputByteLimit: 500,
            shown: "A=1 ls x",
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
            { command: "x".repeat(4001) },
            // The line fits, but not with the variables in front of it: the person must read whole what they allow.
            { command: "ls", env: Array.from({ length: 10 }, (_, index) => { return { name: `V${String(index)}`, value: "v".repeat(400) }; }) },
        ]) {
            expect(() => createRequestOf(params)).toThrow();
        }
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
});
