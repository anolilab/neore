import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { Context as AiContext, FlexibleSchema, ToolExecutionOptions, ToolResultOutput } from "@ai-sdk/provider-utils";
import type { ModelMessage, Tool, ToolSet } from "ai";
import { tool } from "ai";

import type { ProviderOptions } from "../validators";
import type { Agent } from "./index";
import type { ActionCtx as ActionContext } from "./types";

export type ResearchDepth = "speed" | "balanced" | "thorough";

export type ToolCtx = ActionContext & {
    agent?: Agent;
    messageId?: string;
    /** Controls search depth/thoroughness for web search and deep research tools */
    researchDepth?: ResearchDepth;
    threadId?: string;
    userId?: string;
    /** Caller-supplied user tier ("free" | "premium" | "ultra" | "public" | "anonymous"). Tools fall back to "free" when absent. */
    userTier?: string;
};

/**
 * Function that is called to determine if the tool needs approval before it can be executed.
 */
export type ToolNeedsApprovalFunctionCtx<INPUT, Context extends ToolCtx = ToolCtx> = (
    context: Context,
    input: INPUT,
    options: {
        /**
         * Additional context.
         *
         * Experimental (can break in patch releases).
         */
        experimental_context?: unknown;

        /**
         * Messages that were sent to the language model to initiate the response that contained the tool call.
         * The messages **do not** include the system prompt nor the assistant response that contained the tool call.
         */
        messages: ModelMessage[];

        /**
         * The ID of the tool call. You can use it e.g. when sending tool-call related information with stream data.
         */
        toolCallId: string;
    },
) => boolean | PromiseLike<boolean>;

export type ToolExecuteFunctionCtx<INPUT, OUTPUT, Context extends ToolCtx = ToolCtx> = (
    context: Context,
    input: INPUT,
    options: ToolExecutionOptions<unknown>,
) => AsyncIterable<OUTPUT> | PromiseLike<OUTPUT>;

/**
 * Error message type for deprecated 'handler' property.
 * Using a string literal type causes TypeScript to show this message in errors.
 */
type HANDLER_REMOVED_ERROR = "The 'handler' property has been removed in v0.6.0. Use 'execute' instead.";

export type ToolOutputPropertiesCtx<INPUT, OUTPUT, Context extends ToolCtx = ToolCtx> = {
    /**
     * An async function that is called with the arguments from the tool call and produces a result.
     * If `execute` is not provided, the tool will not be executed automatically.
     * @param input The input of the tool call.
     * @param options.abortSignal A signal that can be used to abort the tool call.
     */
    execute: ToolExecuteFunctionCtx<INPUT, OUTPUT, Context>;

    /**
     * @deprecated Removed in v0.6.0. Use `execute` instead.
     */
    handler?: HANDLER_REMOVED_ERROR;
    outputSchema?: FlexibleSchema<OUTPUT>;
};

export type ToolInputProperties<INPUT> = {
    /**
     * The schema of the input that the tool expects.
     * The language model will use this to generate the input.
     * It is also used to validate the output of the language model.
     *
     * You can use descriptions on the schema properties to make the input understandable for the language model.
     */
    inputSchema: FlexibleSchema<INPUT>;
};

/**
 * This is a wrapper around the ai.tool function that adds extra context to the
 * tool call, including the action context, userId, threadId, and messageId.
 * The parameters `args` and `handler` have been removed in v0.6.0, use `inputSchema` and `execute` instead.
 * @returns A tool to be used with the AI SDK.
 */
export const createTool = <INPUT, OUTPUT, Context extends ToolCtx = ToolCtx>(
    definition: {
        /**
         * An optional description of what the tool does.
         * Will be used by the language model to decide whether to use the tool.
         * Not used for provider-defined tools.
         */
        description?: string;

        /**
         * Additional provider-specific metadata. They are passed through
         * to the provider from the AI SDK and enable provider-specific
         * functionality that can be fully encapsulated in the provider.
         */
        providerOptions?: ProviderOptions;

        /**
         * An optional title of the tool.
         */
        title?: string;
    } & ToolInputProperties<INPUT> & {
            /**
             * Provide the context to use, e.g. when defining the tool at runtime.
             */
            ctx?: Context;

            /**
             * An optional list of input examples that show the language
             * model what the input should look like.
             */
            inputExamples?: {
                input: NoInfer<INPUT>;
            }[];

            /**
             * Whether the tool needs approval before it can be executed.
             */
            needsApproval?: boolean | ToolNeedsApprovalFunctionCtx<[INPUT] extends [never] ? unknown : INPUT, Context>;

            /**
             * Optional function that is called when a tool call can be started,
             * even if the execute function is not provided.
             */
            onInputAvailable?: (
                context: Context,
                options: ToolExecutionOptions<unknown> & {
                    input: [INPUT] extends [never] ? unknown : INPUT;
                },
            ) => void | PromiseLike<void>;

            /**
             * Optional function that is called when an argument streaming delta is available.
             * Only called when the tool is used in a streaming context.
             */
            onInputDelta?: (context: Context, options: ToolExecutionOptions<unknown> & { inputTextDelta: string }) => void | PromiseLike<void>;

            /**
             * Optional function that is called when the argument streaming starts.
             * Only called when the tool is used in a streaming context.
             */
            onInputStart?: (context: Context, options: ToolExecutionOptions<unknown>) => void | PromiseLike<void>;

            /**
             * Strict mode setting for the tool.
             *
             * Providers that support strict mode will use this setting to determine
             * how the input should be generated. Strict mode will always produce
             * valid inputs, but it might limit what input schemas are supported.
             */
            strict?: boolean;
        } & ToolOutputPropertiesCtx<INPUT, OUTPUT, Context> & {
            /**
             * Optional conversion function that maps the tool result to an output that can be used by the language model.
             *
             * If not provided, the tool result will be sent as a JSON object.
             */
            toModelOutput?: (
                context: Context,
                options: {
                    /**
                     * The input of the tool call.
                     */
                    input: [INPUT] extends [never] ? unknown : INPUT;

                    /**
                     * The output of the tool call.
                     */
                    output: 0 extends 1 & OUTPUT ? any : [OUTPUT] extends [never] ? any : NoInfer<OUTPUT>;

                    /**
                     * The ID of the tool call. You can use it e.g. when sending tool-call related information with stream data.
                     */
                    toolCallId: string;
                },
            ) => ToolResultOutput | PromiseLike<ToolResultOutput>;
        },
): Tool<INPUT, OUTPUT> => {
    if (!definition.inputSchema) {
        throw new Error("To use a tool, you must provide an `inputSchema`");
    }

    if (!definition.execute && !definition.outputSchema) {
        throw new Error("To use a tool, you must either provide an execute handler function, define an outputSchema, or both");
    }

    // Three generics. ai@7's `tool` is `tool<INPUT, OUTPUT, CONTEXT extends Context>`,
    // and the two-argument form resolves against a DIFFERENT overload —
    // `tool<INPUT, CONTEXT>` — so `OUTPUT` was landing in the context slot and
    // failing its constraint. Passing the default `Context` explicitly picks the
    // overload actually meant here.
    const t = tool<INPUT, OUTPUT, AiContext>({
        __acceptsCtx: true,
        ctx: definition.ctx,
        description: definition.description,
        inputExamples: definition.inputExamples,
        inputSchema: definition.inputSchema,
        needsApproval(this: Tool<INPUT, OUTPUT>, input, options) {
            const { needsApproval } = definition;

            if (!needsApproval || typeof needsApproval === "boolean") {
                return Boolean(needsApproval);
            }

            if (!getContext(this)) {
                throw new Error(
                    "To use a tool, you must either provide the ctx" +
                        " at definition time (dynamically in an action), or use the Agent to" +
                        " call it (which injects the ctx, userId and threadId)",
                );
            }

            return needsApproval(getContext(this), input, options);
        },
        // Storage/SDK boundary: our `providerOptions` has `unknown` leaves, the SDK's
        // `SharedV4ProviderOptions` wants `JSONValue`. Same cast as everywhere else.
        providerOptions: definition.providerOptions as SharedV4ProviderOptions | undefined,
        strict: definition.strict,
        title: definition.title,
        type: "function",
        ...(definition.execute && {
            execute(this: Tool<INPUT, OUTPUT>, input: INPUT, options: ToolExecutionOptions<unknown>) {
                if (!getContext(this)) {
                    throw new Error(
                        "To use a tool, you must either provide the ctx" +
                            " at definition time (dynamically in an action), or use the Agent to" +
                            " call it (which injects the ctx, userId and threadId)",
                    );
                }

                return definition.execute!(getContext(this), input, options);
            },
        }),
        outputSchema: definition.outputSchema,
    });

    // Lifecycle callbacks must resolve ctx at call time — `wrapTools` later
    // attaches a per-invocation `ctx` to the tool object, so binding via
    // `Function.prototype.bind(t, getCtx(t))` would freeze in the stale
    // (undefined) definition-time ctx.
    if (definition.onInputStart) {
        const { onInputStart } = definition;

        t.onInputStart = function onInputStartWithContext(this: Tool<INPUT, OUTPUT>, options) {
            return onInputStart(getContext(this), options);
        };
    }

    if (definition.onInputDelta) {
        const { onInputDelta } = definition;

        t.onInputDelta = function onInputDeltaWithContext(this: Tool<INPUT, OUTPUT>, options) {
            return onInputDelta(getContext(this), options);
        };
    }

    if (definition.onInputAvailable) {
        const { onInputAvailable } = definition;

        t.onInputAvailable = function onInputAvailableWithContext(this: Tool<INPUT, OUTPUT>, options) {
            return onInputAvailable(getContext(this), options);
        };
    }

    if (definition.toModelOutput) {
        const { toModelOutput } = definition;

        t.toModelOutput = function toModelOutputWithContext(this: Tool<INPUT, OUTPUT>, options) {
            return toModelOutput(getContext(this), options);
        };
    }

    return t;
};

const getContext = <Context extends ToolCtx>(toolDefinition: any): Context => (toolDefinition as { ctx: Context }).ctx;

export const wrapTools = (context: ToolCtx, ...toolSets: (ToolSet | undefined)[]): ToolSet => {
    const output = {} as ToolSet;

    for (const toolSet of toolSets) {
        if (!toolSet) {
            continue;
        }

        for (const [name, toolDefinition] of Object.entries(toolSet)) {
            if (toolDefinition && !(toolDefinition as { __acceptsCtx?: boolean }).__acceptsCtx) {
                output[name] = toolDefinition;
            } else {
                const out = { ...toolDefinition, ctx: context };

                output[name] = out;
            }
        }
    }

    return output;
};
