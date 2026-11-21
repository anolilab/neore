/**
 * `instruction_read`: reads one of the project's `auto` rule files, the ones a run lists by name and description
 * (`projects/rule-files.ts#renderInstructionList`). Built per run over the files that run's one rule-file read listed
 * (`getProjectContextForRun`, `runProjectFor`), so it reaches the run's own project and nothing else, and reads no
 * database. The call is saved with the reply like any tool call, so each read shows in the run's details. Offered only
 * when the run lists at least one file, as a built-in candidate of `buildAgentTools`, so the cap, a bot's selection, a skill
 * and the user's permissions remove it like any other tool.
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import { oneLine, type RunInstruction } from "../../projects/rule-files";
import toonEncodeOutput from "./toon-encode";

type InstructionReadOutput =
    | { found: false; ids: string[]; reason: string }
    | { found: false; names: string[] }
    | { found: true; id: string; name: string; text: string };

/**
 * The files `file` names: the one with that id, else every one with that name, ignoring case and surrounding space. Ids
 * are unique and names need not be, so more than one means the name alone does not say which.
 */
export const findInstruction = (instructions: ReadonlyArray<RunInstruction>, file: string): RunInstruction[] => {
    const wanted = file.trim();
    const byId = instructions.find((entry) => entry.id === wanted);

    if (byId) {
        return [byId];
    }

    // As the list shows it (`oneLine`), so a name with a line break in it is still found.
    const lower = oneLine(wanted).toLowerCase();

    return instructions.filter((entry) => oneLine(entry.title).toLowerCase() === lower);
};

/** The tool over `instructions`, the `auto` files the run lists. */
export const instructionReadTool = (instructions: ReadonlyArray<RunInstruction>) =>
    createTool<{ file: string }, InstructionReadOutput, ToolContext>({
        description:
            "Read one of the project's instruction files listed in the system prompt, by its id (or its name, when no other file has it), when it applies to the task. Returns its full text.",
        execute: async (_context, { file }) => {
            const matches = findInstruction(instructions, file);
            const [found] = matches;

            // Only ids, never the text: the files are the owner's.
            toolsLogger.info("[instruction_read]", { fileId: matches.length === 1 ? found!.id : null, matches: matches.length });

            if (!found) {
                return { found: false, names: instructions.map((entry) => oneLine(entry.title)) };
            }

            // Never a guess between files of the same name: the model asks again by id, which the list shows.
            if (matches.length > 1) {
                return { found: false, ids: matches.map((entry) => entry.id), reason: "Several files have this name: read one by its id." };
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
