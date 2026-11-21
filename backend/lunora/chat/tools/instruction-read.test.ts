import { describe, expect, it } from "vitest";

import { findInstruction, instructionReadTool } from "./instruction-read";

const deploy = { content: "Run the deploy script.", description: "How to deploy", id: "deploy-1", title: "Deploy" };
const style = { content: "Use tabs.", description: "Code style", id: "style", title: "Style guide" };

describe("instruction_read", () => {
    it("finds a listed file by its id, else by its name in any case", () => {
        expect(findInstruction([deploy, style], "deploy-1")).toStrictEqual([deploy]);
        expect(findInstruction([deploy, style], "  style GUIDE ")).toStrictEqual([style]);
        expect(findInstruction([deploy, style], "secrets")).toStrictEqual([]);
        expect(findInstruction([{ ...style, title: "Style\n guide" }], "style guide")[0]?.id).toBe("style");
    });

    it("returns the file's text, and the listed names for one it does not have", async () => {
        // As the agent calls it: with the run's context on the tool (`wrapTools`).
        const tool = { ...instructionReadTool([deploy, style]), ctx: { userId: "u1" } } as unknown as {
            execute: (input: { file: string }, options: unknown) => Promise<unknown>;
        };
        const options = { messages: [], toolCallId: "call-1" };

        await expect(tool.execute({ file: "Deploy" }, options)).resolves.toStrictEqual({
            found: true,
            id: "deploy-1",
            name: "Deploy",
            text: "Run the deploy script.",
        });
        await expect(tool.execute({ file: "other" }, options)).resolves.toStrictEqual({ found: false, names: ["Deploy", "Style guide"] });
    });

    it("never guesses between files of the same name: it names their ids, and reads the one asked for by id", async () => {
        const other = { ...deploy, content: "Staging only.", id: "deploy-2" };
        const tool = { ...instructionReadTool([deploy, other]), ctx: { userId: "u1" } } as unknown as {
            execute: (input: { file: string }, options: unknown) => Promise<unknown>;
        };
        const options = { messages: [], toolCallId: "call-1" };

        await expect(tool.execute({ file: "deploy" }, options)).resolves.toMatchObject({ found: false, ids: ["deploy-1", "deploy-2"] });
        await expect(tool.execute({ file: "deploy-2" }, options)).resolves.toMatchObject({ found: true, text: "Staging only." });
    });

    it("never reads another file under a name that is some file's id: it names both, and reads either in the id form", async () => {
        // A file named like another file's id.
        const named = { ...style, content: "Not the deploy file.", id: "style-2", title: "deploy-1" };
        const tool = { ...instructionReadTool([deploy, named]), ctx: { userId: "u1" } } as unknown as {
            execute: (input: { file: string }, options: unknown) => Promise<unknown>;
        };
        const options = { messages: [], toolCallId: "call-1" };

        await expect(tool.execute({ file: "deploy-1" }, options)).resolves.toMatchObject({ found: false, ids: ["deploy-1", "style-2"] });
        await expect(tool.execute({ file: "id:deploy-1" }, options)).resolves.toMatchObject({ found: true, text: "Run the deploy script." });
        await expect(tool.execute({ file: "ID: style-2" }, options)).resolves.toMatchObject({ found: true, text: "Not the deploy file." });
        await expect(tool.execute({ file: "id:<style-2>" }, options)).resolves.toMatchObject({ found: true, text: "Not the deploy file." });
    });

    it("answers an id form that names no file as not found, never by a name", () => {
        // A save refuses a new such name, but one saved before keeps it and must not be read for an id.
        const named = { ...style, id: "style-2", title: "id:abc" };

        expect(findInstruction([deploy, named], "id:abc")).toStrictEqual([]);
        expect(findInstruction([deploy, named], "id:Deploy")).toStrictEqual([]);
        expect(findInstruction([deploy, named], "id:")).toStrictEqual([]);
    });

    it("reads a file saved under a name opening the id form by its id only", () => {
        const named = { ...style, id: "style-2", title: "id:abc" };

        expect(findInstruction([deploy, named], "style-2")).toStrictEqual([named]);
        expect(findInstruction([deploy, named], "id:style-2")).toStrictEqual([named]);
    });

    it("names a file saved under a name opening the id form by its own id form when it has no file asked for", async () => {
        const named = { ...style, id: "style-2", title: "id:abc" };
        const tool = { ...instructionReadTool([deploy, named]), ctx: { userId: "u1" } } as unknown as {
            execute: (input: { file: string }, options: unknown) => Promise<unknown>;
        };

        await expect(tool.execute({ file: "secrets" }, { messages: [], toolCallId: "call-1" })).resolves.toStrictEqual({
            found: false,
            names: ["Deploy", "id:style-2"],
        });
    });
});
