import type { CallWarning, LanguageModelRequestMetadata, LanguageModelUsage } from "ai";

import type { ActionCtx as ActionContext, MutationCtx as MutationContext, QueryCtx as QueryContext, RunnerCtx } from "./types";

/** Any context that can read: a query, a mutation or an action. */
export type ReadableAgentContext = QueryContext | MutationContext | ActionContext;

/** Any context that can write: a mutation, an action, or a runner. */
export type WritableAgentContext = MutationContext | ActionContext | RunnerCtx;

/**
 * Compatibility type for streamObject return value.
 * Maps the new AI SDK v6 Output API (streamText with Output) to the old streamObject interface.
 */
export interface StreamObjectCompatResult<RESULT> {
    /** Promise that resolves to the final complete object */
    readonly object: Promise<RESULT>;
    /** Stream of partial objects as they are being generated */
    readonly partialObjectStream: AsyncIterable<Partial<RESULT>>;
    /** Request metadata */
    readonly request: Promise<LanguageModelRequestMetadata>;
    /** Convert the stream to a Response for HTTP streaming */
    toTextStreamResponse: () => Response;
    /** Token usage information */
    readonly usage: Promise<LanguageModelUsage>;
    /** Warnings from the model provider */
    readonly warnings: Promise<CallWarning[] | undefined>;
}

/**
 * Sentinel stamped onto the args of a context-compression retry so the retry
 * cannot recurse. It is deliberately not part of `TextArgs` — it never reaches
 * the model — so it needs its own carrier type rather than widening the
 * public argument type.
 */
export type ContextRetryMarker = { _contextRetried?: boolean };

/**
 * Marker that `createTool` stamps on tools wanting our `ToolCtx` injected.
 * ai@7's `Tool` has no slot for it, so reading it needs this narrowing.
 * @see ./createTool.ts
 */
export type ContextAcceptingTool = { __acceptsCtx?: boolean };
