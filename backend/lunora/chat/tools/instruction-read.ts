/**
 * `instruction_read`: reads one of the project's `auto` rule files, the ones a run lists by name and description
 * (`projects/rule-files.ts#renderInstructionList`). Built per run over the files that run's one rule-file read listed
 * (`getProjectContextForRun`, `runProjectFor`), so it reaches the run's own project and nothing else, and reads no
 * database. The call is saved with the reply like any tool call, so each read shows in the run's details. Offered only
 * when the run lists at least one file ({@link withInstructionRead}).
 */
import type { ToolSet } from "ai";
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import { INSTRUCTION_READ_TOOL, oneLine, type RunInstruction } from "../../projects/rule-files";
import toonEncodeOutput from "./toon-encode";

type InstructionReadOutput = { found: false; names: string[] } | { found: true; id: string; name: string; text: string };

/** The file `file` names: its id, else its name, ignoring case and surrounding space. */
export const findInstruction = (instructions: ReadonlyArray<RunInstruction>, file: string): RunInstruction | undefined => {
    const wanted = file.trim();
    // As the list shows it (`oneLine`), so a name with a line break in it is still found.
    const lower = oneLine(wanted).toLowerCase();

    return instructions.find((entry) => entry.id === wanted) ?? instructions.find((entry) => oneLine(entry.title).toLowerCase() === lower);
};

/** The tool over `instructions`, the `auto` files the run lists. */
export const instructionReadTool = (instructions: ReadonlyArray<RunInstruction>) =>
    createTool<{ file: string }, InstructionReadOutput, ToolContext>({
        description:
            "Read one of the project's instruction files listed in the system prompt, by its name or id, when it applies to the task. Returns its full text.",
        execute: async (_context, { file }) => {
            const found = findInstruction(instructions, file);

            // Only ids, never the text: the files are the owner's.
            toolsLogger.info("[instruction_read]", { fileId: found?.id ?? null, found: found !== undefined });

            if (!found) {
                return { found: false, names: instructions.map((entry) => oneLine(entry.title)) };
            }

            return { found: true, id: found.id, name: found.title, text: found.content };
        },
        inputSchema: z
            .object({
                file: z.string().min(1).max(200).meta({ description: "The instruction file's name or id, as listed" }),
            })
            .strict(),
        title: "Project instructions",
        toModelOutput: (_context, { output }) => toonEncodeOutput(output),
    });

/**
 * `tools` with {@link instructionReadTool} over `instructions`, unchanged when there are none: a run without `auto`
 * files has no such tool. The tool is the run's own context, like the rule text in its prompt, not a capability, so it
 * is added after the permission layer and a bot's selection, which never list it.
 */
export const withInstructionRead = (tools: ToolSet, instructions: ReadonlyArray<RunInstruction> | undefined): ToolSet =>
    instructions && instructions.length > 0 ? { ...tools, [INSTRUCTION_READ_TOOL]: instructionReadTool(instructions) } : tools;
