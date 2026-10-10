/**
 * Tool definitions -> AI SDK `ToolSet`.
 *
 * Callers hand the gateway tools in two wire shapes — a named array
 * (`/internal/*`) and OpenAI's `{ type: "function", function: {...} }`
 * (`/v1/chat/completions`). The AI SDK wants neither: it wants a record keyed
 * by tool name whose values carry an `inputSchema`.
 *
 * Getting this wrong fails silently rather than loudly, which is why it is
 * centralised here:
 *
 *   - Passing the array straight through leaves `Object.keys()` returning
 *     `"0"`, `"1"`, ... so every tool reaches the model named after its
 *     index and nothing matches the names the caller will be asked to
 *     execute.
 *   - `parameters` is the v4 field name. v6 reads `inputSchema` and ignores
 *     anything else, so a tool declared with `parameters` arrives with no
 *     schema at all: the model is told the tool exists and nothing about how
 *     to call it.
 *
 * Neither produces an error from the provider — just tools that never fire,
 * or fire with empty arguments.
 */
import type { ToolSet } from "ai";
import { jsonSchema } from "ai";

import type { ToolDefinition } from "../providers/adapters/types.js";

/** Minimal JSON Schema stand-in for a tool that declares no parameters. */
const EMPTY_OBJECT_SCHEMA = { properties: {}, type: "object" as const };

/**
 * Build a `ToolSet` from the gateway's internal tool-definition array.
 *
 * Returns `undefined` for an empty or absent list so callers can spread the
 * result without sending `tools: {}`, which some providers reject.
 */
export const toToolSet = (definitions: ToolDefinition[] | undefined): ToolSet | undefined => {
    if (!definitions || definitions.length === 0) {
        return undefined;
    }

    const entries = definitions.map((definition) => [
        definition.name,
        {
            description: definition.description,
            inputSchema: jsonSchema(
                Object.keys(definition.parameters ?? {}).length > 0 ? (definition.parameters as Record<string, unknown>) : EMPTY_OBJECT_SCHEMA,
            ),
        },
    ]);

    return Object.fromEntries(entries) as ToolSet;
};

/** OpenAI-style tool as it arrives on `/v1/chat/completions`. */
export interface OpenAIFunctionTool {
    function: {
        description?: string;
        name: string;
        parameters?: Record<string, unknown>;
    };
}

/** Build a `ToolSet` from OpenAI-shaped `tools`. */
export const openAIToolsToToolSet = (tools: OpenAIFunctionTool[] | undefined): ToolSet | undefined =>
    toToolSet(
        tools?.map((t) => {
            return {
                description: t.function.description ?? "",
                name: t.function.name,
                parameters: t.function.parameters ?? {},
            };
        }),
    );
