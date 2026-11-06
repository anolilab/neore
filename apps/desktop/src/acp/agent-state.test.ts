import { describe, expect, it, vi } from "vitest";

import { availableCommandsOf, usageOf } from "./agent-state";

const plain = (text: string): string => text;

describe("usageOf", () => {
    it("reads the context use and window of a usage update", () => {
        expect(usageOf({ sessionUpdate: "usage_update", size: 200_000, used: 12_345 }, plain)).toEqual({ size: 200_000, used: 12_345 });
    });

    it("keeps a cost the agent reported, and only that", () => {
        expect(usageOf({ cost: { amount: 0.42, currency: "USD" }, size: 1000, used: 10 }, plain)).toEqual({
            cost: { amount: 0.42, currency: "USD" },
            size: 1000,
            used: 10,
        });
        expect(usageOf({ cost: null, size: 1000, used: 10 }, plain)).toEqual({ size: 1000, used: 10 });
    });

    it.each([
        ["a missing used", { size: 1000 }],
        ["a missing size", { used: 10 }],
        ["a fraction", { size: 1000.5, used: 10 }],
        ["a negative count", { size: 1000, used: -1 }],
        ["a text count", { size: "1000", used: 10 }],
        ["an unsafe integer", { size: Number.MAX_SAFE_INTEGER + 2, used: 10 }],
    ])("refuses %s", (_name, update) => {
        expect(usageOf({ sessionUpdate: "usage_update", ...update }, plain)).toBeUndefined();
    });

    it("drops a cost that is not a finite non-negative amount with a currency, and keeps the usage", () => {
        for (const cost of [{ amount: -1, currency: "USD" }, { amount: NaN, currency: "USD" }, { amount: 1 }, { amount: 1, currency: "" }, "1 USD"]) {
            expect(usageOf({ cost, size: 1000, used: 10 }, plain)).toEqual({ size: 1000, used: 10 });
        }
    });

    it("scrubs and cuts the currency code", () => {
        const scrub = (text: string) => text.replaceAll("SECRET", "");
        const usage = usageOf({ cost: { amount: 1, currency: "SECRETUSDTOOLONG" }, size: 1, used: 0 }, scrub);

        expect(usage?.cost?.currency).toBe("USDTOOLO");
    });
});

describe("availableCommandsOf", () => {
    it("reads no more than 1000 entries, valid or not, so a long list of malformed ones stays bounded", () => {
        const malformed: Record<string, string>[] = [];
        const blanks: Record<string, string>[] = [];
        const valid = { description: "Late", name: "late" };

        for (let index = 0; index < 5000; index += 1) {
            malformed.push({ description: "x" });
        }

        for (let index = 0; index < 1000; index += 1) {
            blanks.push({});
        }

        expect(availableCommandsOf({ availableCommands: [...malformed, valid] }, plain)).toEqual([]);
        expect(availableCommandsOf({ availableCommands: [...blanks, valid] }, plain)).toEqual([]);
    });

    it("drops a name longer than 64 characters rather than cutting it, and keeps two long names apart", () => {
        const long = "x".repeat(64);

        expect(availableCommandsOf({ availableCommands: [{ name: `${long}-a` }, { name: `${long}-b` }, { name: "short" }] }, plain)).toEqual([
            { description: "", name: "short" },
        ]);
    });

    it("drops a name the scrub would change, since the person would see a different command", () => {
        const scrub = (text: string) => text.replaceAll("SECRET", "");

        expect(availableCommandsOf({ availableCommands: [{ name: "run-SECRET" }, { name: "run" }] }, scrub)).toEqual([{ description: "", name: "run" }]);
    });

    it("drops a name with a space or a line break: a command is one token in the draft", () => {
        expect(availableCommandsOf({ availableCommands: [{ name: "foo\nbar" }, { name: "two words" }, { name: "single" }] }, plain)).toEqual([
            { description: "", name: "single" },
        ]);
    });

    it("leaves a description longer than 4096 characters out, without scrubbing it, and keeps the command", () => {
        const long = "x".repeat(4097);
        const scrubbed = vi.fn(plain);

        expect(availableCommandsOf({ availableCommands: [{ description: long, input: { hint: long }, name: "long" }, { name: "short" }] }, scrubbed)).toEqual([
            { description: "", name: "long" },
            { description: "", name: "short" },
        ]);
        expect(scrubbed).not.toHaveBeenCalledWith(long);
    });

    it("drops an entry whose name is longer than 4096 characters, since a cut name would name another command", () => {
        expect(availableCommandsOf({ availableCommands: [{ name: "n".repeat(4097) }, { name: "short" }] }, plain)).toEqual([{ description: "", name: "short" }]);
    });

    it("reads the commands with their description and input hint", () => {
        const update = {
            availableCommands: [
                { description: "Compact the context", name: "compact" },
                { description: "Review changes", input: { hint: "a branch" }, name: "review" },
            ],
            sessionUpdate: "available_commands_update",
        };

        expect(availableCommandsOf(update, plain)).toEqual([
            { description: "Compact the context", name: "compact" },
            { description: "Review changes", hint: "a branch", name: "review" },
        ]);
    });

    it("answers undefined when the list is not an array, and an empty list for an empty one", () => {
        expect(availableCommandsOf({ availableCommands: "x" }, plain)).toBeUndefined();
        expect(availableCommandsOf({}, plain)).toBeUndefined();
        expect(availableCommandsOf({ availableCommands: [] }, plain)).toEqual([]);
    });

    it("skips entries without a usable name", () => {
        expect(availableCommandsOf({ availableCommands: [null, 3, { name: "" }, { description: "x" }, { name: "ok" }] }, plain)).toEqual([{ description: "", name: "ok" }]);
    });

    it("cuts the list and each text to its bound", () => {
        const many = Array.from({ length: 150 }, (_, index) => {
            return { name: `c${index}` };
        });

        expect(availableCommandsOf({ availableCommands: many }, plain)).toHaveLength(100);

        const [long] = availableCommandsOf({ availableCommands: [{ description: "d".repeat(500), input: { hint: "h".repeat(500) }, name: "n".repeat(64) }] }, plain) ?? [];

        expect(long?.name).toHaveLength(64);
        expect(long?.description).toHaveLength(300);
        expect(long?.hint).toHaveLength(200);
    });

    it("scrubs every description and hint, and drops a command whose name the scrub would change", () => {
        const scrub = (text: string) => text.replaceAll("SECRET", "***");

        expect(
            availableCommandsOf({ availableCommands: [{ description: "uses SECRET", input: { hint: "SECRET" }, name: "SECRETcmd" }, { description: "uses SECRET", name: "ok" }] }, scrub),
        ).toEqual([{ description: "uses ***", name: "ok" }]);
    });
});
