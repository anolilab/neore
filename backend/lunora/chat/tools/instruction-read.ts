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

/** Opens the explicit form of an id (`id:<id>`), which no name is read as; in any case. */
const ID_FORM = "id:";
const ANGLE_BRACKETS = /^<|>$/gu;

/**
 * The files `file` names: with the `id:` form ({@link ID_FORM}) the one with that id; otherwise every one whose id is
 * `file` or whose name is, ignoring case and surrounding space. Ids are unique, but names need not be and a name may be
 * another file's id, so more than one means `file` alone does not say which.
 */
export const findInstruction = (instructions: ReadonlyArray<RunInstruction>, file: string): RunInstruction[] => {
    const wanted = file.trim();
    // Angle brackets kept from the `id:<its id>` the list and the ambiguous answer show are not part of the id.
    const explicitId = wanted.toLowerCase().startsWith(ID_FORM) ? wanted.slice(ID_FORM.length).trim().replaceAll(ANGLE_BRACKETS, "") : undefined;
    const byExplicitId = explicitId ? instructions.find((entry) => entry.id === explicitId) : undefined;

    if (byExplicitId) {
        return [byExplicitId];
    }

    // As the list shows it (`oneLine`), so a name with a line break in it is still found.
    const lower = oneLine(wanted).toLowerCase();

    return instructions.filter((entry) => entry.id === wanted || oneLine(entry.title).toLowerCase() === lower);
};

/** The tool over `instructions`, the `auto` files the run lists. */
export const instructionReadTool = (instructions: ReadonlyArray<RunInstruction>) =>
    createTool<{ file: string }, InstructionReadOutput, ToolContext>({
        description:
            "Read one of the project's instruction files listed in the system prompt, by its id (written id:<id> when the bare id or name could mean another file) or its name, when it applies to the task. Returns its full text.",
        execute: async (_context, { file }) => {
            const matches = findInstruction(instructions, file);
            const [found] = matches;

            // Only ids, never the text: the files are the owner's.
            toolsLogger.info("[instruction_read]", { fileId: matches.length === 1 ? found!.id : null, matches: matches.length });

            if (!found) {
                return { found: false, names: instructions.map((entry) => oneLine(entry.title)) };
            }

            // Never a guess between files `file` could mean: the model asks again in the id form, which no name is read as.
            if (matches.length > 1) {
                return { found: false, ids: matches.map((entry) => entry.id), reason: "Several files match this: read one as id:<its id>." };
            }

            return { found: true, id: found.id, name: found.title, text: found.content };
        },
        inputSchema: z
            .object({
                file: z.string().min(1).max(200).meta({ description: "The instruction file's name or id as listed, or id:<id>" }),
            })
            .strict(),
        title: "Project instructions",
        toModelOutput: (_context, { output }) => toonEncodeOutput(output),
    });
