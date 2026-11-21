import { describe, expect, it } from "vitest";

import { INSTRUCTION_READ_TOOL } from "../../projects/rule-files";
import { findInstruction, instructionReadTool, withInstructionRead } from "./instruction-read";

const deploy = { content: "Run the deploy script.", description: "How to deploy", id: "deploy-1", title: "Deploy" };
const style = { content: "Use tabs.", description: "Code style", id: "style", title: "Style guide" };

describe("instruction_read", () => {
    it("finds a listed file by its id, else by its name in any case", () => {
        expect(findInstruction([deploy, style], "deploy-1")).toBe(deploy);
        expect(findInstruction([deploy, style], "  style GUIDE ")).toBe(style);
        expect(findInstruction([deploy, style], "secrets")).toBeUndefined();
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

    it("is offered only to a run that lists at least one file", () => {
        expect(withInstructionRead({}, [])).toStrictEqual({});
        expect(withInstructionRead({}, undefined)).toStrictEqual({});
        expect(Object.keys(withInstructionRead({}, [deploy]))).toStrictEqual([INSTRUCTION_READ_TOOL]);
    });
});
