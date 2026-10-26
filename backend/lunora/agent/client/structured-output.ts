import type { JSONValue } from "@ai-sdk/provider";
import { type FlexibleSchema, getErrorMessage, type InferSchema } from "@ai-sdk/provider-utils";
import type { CallWarning, GenerateObjectResult, LanguageModelRequestMetadata, LanguageModelUsage, ToolSet } from "ai";
import { generateText, Output as AIOutput, streamText as streamTextAI } from "ai";

import type { StreamObjectCompatResult } from "./agent-types";
import type { Agent } from "./index";
import type { ActionCtx as ActionContext, AgentPrompt, GenerateObjectArgs, GenerationOutputMetadata, ObjectMode, Options, StreamObjectArgs } from "./types";

/**
 * The body of {@link Agent.generateObject}, which documents the arguments.
 */
export async function generateObjectFor<
    CustomContext extends object,
    AgentTools extends ToolSet,
    SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
    OUTPUT extends ObjectMode = InferSchema<SCHEMA> extends string ? "enum" : "object",
    RESULT = OUTPUT extends "array" ? InferSchema<SCHEMA>[] : InferSchema<SCHEMA>,
>(
    agent: Agent<CustomContext, AgentTools>,
    context: ActionContext & CustomContext,
    threadOptions: { threadId?: string; userId?: string | null },
    generateObjectArgs: AgentPrompt & GenerateObjectArgs<SCHEMA, OUTPUT, RESULT>,
    options?: Options,
): Promise<GenerateObjectResult<RESULT> & GenerationOutputMetadata> {
    const { args, fail, getSavedMessages, order, promptMessageId, save } = await agent.start(context, generateObjectArgs, { ...threadOptions, ...options });

    try {
        // Extract schema/enum from args and determine the Output type
        const {
            enum: enumValues,
            mode,
            schema,
            ...restArgs
        } = args as typeof args & {
            enum?: RESULT[];
            mode?: OUTPUT;
            schema?: SCHEMA;
        };

        // Build the output specification based on the mode/args
        let output;

        if (enumValues && enumValues.length > 0) {
            // Enum mode: use AIOutput.choice
            output = AIOutput.choice({ options: enumValues as string[] });
        } else if (mode === "array" && schema) {
            // Array mode: use AIOutput.array
            output = AIOutput.array({ element: schema });
        } else if (schema) {
            // Object mode (default): use AIOutput.object
            output = AIOutput.object({ schema });
        } else {
            // No schema: use AIOutput.json for unstructured JSON
            output = AIOutput.json();
        }

        // Call generateText with the Output API
        const textResult = await generateText({
            ...restArgs,
            output,
        });

        // Extract the output - use Output API result if available, otherwise parse text as JSON
        let outputObject: RESULT;

        try {
            // Try to get structured output from the Output API
            outputObject = textResult.output as RESULT;
        } catch {
            // Fallback: parse text response as JSON for models that don't support structured outputs
            if (textResult.text) {
                try {
                    outputObject = JSON.parse(textResult.text) as RESULT;
                } catch {
                    throw new Error(`Failed to parse model response as JSON: ${textResult.text}`);
                }
            } else {
                throw new Error("No output generated: model returned neither structured output nor parseable text");
            }
        }

        // Map the result to GenerateObjectResult format for backward compatibility
        const result = {
            finishReason: textResult.finishReason,
            object: outputObject,
            providerMetadata: textResult.providerMetadata,
            reasoning: textResult.reasoningText,
            request: textResult.request,
            response: textResult.response,
            toJsonResponse: () => Response.json(textResult.output),
            usage: textResult.usage,
            warnings: textResult.warnings,
        } as GenerateObjectResult<RESULT>;

        await save({ object: result });
        const metadata: GenerationOutputMetadata = {
            order,
            promptMessageId,
            savedMessages: getSavedMessages(),
        };

        return Object.assign(result, metadata);
    } catch (error) {
        await fail(getErrorMessage(error));
        throw error;
    }
}

/**
 * The body of {@link Agent.streamObject}, which documents the arguments.
 */
export async function streamObjectFor<
    CustomContext extends object,
    AgentTools extends ToolSet,
    SCHEMA extends FlexibleSchema<unknown> = FlexibleSchema<JSONValue>,
    OUTPUT extends ObjectMode = InferSchema<SCHEMA> extends string ? "enum" : "object",
    RESULT = OUTPUT extends "array" ? InferSchema<SCHEMA>[] : InferSchema<SCHEMA>,
>(
    agent: Agent<CustomContext, AgentTools>,
    context: ActionContext & CustomContext,
    threadOptions: { threadId?: string; userId?: string | null },
    streamObjectArgs: AgentPrompt & StreamObjectArgs<SCHEMA, OUTPUT, RESULT>,
    options?: Options,
): Promise<GenerationOutputMetadata & StreamObjectCompatResult<RESULT>> {
    const { args, fail, getSavedMessages, order, promptMessageId, save } = await agent.start(context, streamObjectArgs, { ...threadOptions, ...options });

    // Extract schema/enum from args and determine the Output type
    const {
        enum: enumValues,
        mode,
        onError,
        onFinish,
        schema,
        ...restArgs
    } = args as typeof args & {
        enum?: RESULT[];
        mode?: OUTPUT;
        onError?: (error: { error: unknown }) => void | Promise<void>;
        onFinish?: (result: any) => void | Promise<void>;
        schema?: SCHEMA;
    };

    // Build the output specification based on the mode/args
    let output;

    if (enumValues && enumValues.length > 0) {
        output = AIOutput.choice({ options: enumValues as string[] });
    } else if (mode === "array" && schema) {
        output = AIOutput.array({ element: schema });
    } else if (schema) {
        output = AIOutput.object({ schema });
    } else {
        output = AIOutput.json();
    }

    // Store references for the onFinish callback
    let streamRef: ReturnType<typeof streamTextAI> | null = null;

    // Call streamText with the Output API
    const stream = streamTextAI({
        ...restArgs,
        onError: async (error) => {
            console.error(" streamObject onError", error);
            await fail(getErrorMessage(error.error));

            return onError?.(error);
        },
        onFinish: async (result) => {
            // Get the output from the stream
            const outputValue = streamRef ? await streamRef.output : undefined;
            const requestValue = streamRef ? await streamRef.request : ({} as LanguageModelRequestMetadata);

            await save({
                object: {
                    finishReason: result.finishReason,
                    object: outputValue,
                    providerMetadata: result.providerMetadata,
                    reasoning: result.reasoningText,
                    request: requestValue,
                    response: result.response,
                    toJsonResponse: () => streamRef?.toTextStreamResponse() ?? new Response(),
                    usage: result.usage,
                    warnings: result.warnings,
                },
            });

            // Adapt the result for the onFinish callback
            if (onFinish) {
                const adaptedResult = {
                    error: undefined,
                    object: outputValue,
                    providerMetadata: result.providerMetadata,
                    response: result.response,
                    usage: result.usage,
                    warnings: result.warnings,
                };

                await onFinish(adaptedResult);
            }
        },
        output,
    });

    // Store the stream reference for use in onFinish
    streamRef = stream;

    // Create a compatibility wrapper that exposes partialObjectStream (mapped from partialOutputStream)
    const compatStream: StreamObjectCompatResult<RESULT> = {
        get object() {
            return stream.output as unknown as Promise<RESULT>;
        },
        // Map partialOutputStream to partialObjectStream for backward compatibility
        get partialObjectStream() {
            return stream.partialOutputStream as unknown as AsyncIterable<Partial<RESULT>>;
        },
        get request() {
            return stream.request as unknown as Promise<LanguageModelRequestMetadata>;
        },
        toTextStreamResponse: () => stream.toTextStreamResponse(),
        get usage() {
            return stream.usage as unknown as Promise<LanguageModelUsage>;
        },
        get warnings() {
            return stream.warnings as unknown as Promise<CallWarning[] | undefined>;
        },
    };

    const metadata: GenerationOutputMetadata = {
        order,
        promptMessageId,
        savedMessages: getSavedMessages(),
    };

    return Object.assign(compatStream, metadata);
}
