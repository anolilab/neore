/**
 * AI SDK stream -> SSE response adapter.
 *
 * Converts AI SDK v6 streamText result into Server-Sent Events format
 * compatible with the backend's SSE relay.
 *
 * AI SDK v6 fullStream event types:
 *   text-delta (.text), reasoning-delta (.text), tool-call (.toolName, .input),
 *   finish-step (.usage, .finishReason), finish (.totalUsage, .finishReason),
 *   error (.error)
 */
import type { JSONObject } from "@ai-sdk/provider";
import type { ProviderMetadata, streamText } from "ai";

/**
 * Stream chunk types emitted by the gateway SSE stream.
 */
export type StreamChunk =
    | { textDelta: string; type: "text-delta" }

    /**
     * Reasoning delta. `providerMetadata` is forwarded so consumers can
     * round-trip Anthropic extended-thinking signatures (the
     * `providerMetadata.anthropic.signature` field) through message history.
     * Without it, multi-turn reasoning continuity breaks on Anthropic models.
     */
    | { providerMetadata?: ProviderMetadata; textDelta: string; type: "reasoning" }
    | { args: JSONObject; toolCallId: string; toolName: string; type: "tool-call" }
    | {
          type: "step-finish";
          usage: { cachedTokens?: number; completionTokens: number; promptTokens: number; reasoningTokens?: number };
      }
    | {
          cost: { microdollars: number; pricingAvailable: boolean };
          finishReason: string;
          type: "finish";
          usage: { cachedTokens?: number; completionTokens: number; promptTokens: number; reasoningTokens?: number };
      }
    | { error: { code: string; message: string }; type: "error" };

/**
 * Convert an AI SDK streamText result into an async iterable of SSE-formatted strings.
 */

export async function* streamToSSE(
    result: ReturnType<typeof streamText>,

    /**
     * Fired as each tool-call chunk is emitted. Once a tool call has reached the
     * caller, a later stream failure must NOT be silently retried — the side
     * effects have already been requested. The caller owns that decision, so it
     * only needs to know a tool call went out.
     */
    onToolCall?: () => void,
): AsyncGenerator<string> {
    try {
        for await (const part of result.fullStream) {
            switch (part.type) {
                case "error": {
                    yield formatSSE({
                        error: { code: "PROVIDER_ERROR", message: String(part.error) },
                        type: "error",
                    });
                    break;
                }

                case "finish": {
                    // Final finish event is sent separately with cost data by the stream route
                    break;
                }

                case "finish-step": {
                    if (part.usage) {
                        yield formatSSE({
                            type: "step-finish",
                            usage: {
                                completionTokens: part.usage.outputTokens ?? 0,
                                promptTokens: part.usage.inputTokens ?? 0,
                            },
                        });
                    }

                    break;
                }

                case "reasoning-delta": {
                    // Forward providerMetadata so Anthropic thinking-block
                    // signatures survive into the persisted message history.
                    const { providerMetadata } = part as { providerMetadata?: ProviderMetadata };

                    yield formatSSE({
                        textDelta: part.text,
                        type: "reasoning",
                        ...(providerMetadata && { providerMetadata }),
                    });
                    break;
                }

                case "text-delta": {
                    yield formatSSE({ textDelta: part.text, type: "text-delta" });
                    break;
                }

                case "tool-call": {
                    onToolCall?.();
                    // AI SDK v6 uses `.input` on tool-call parts; map to gateway's `.args` wire format
                    yield formatSSE({
                        args: (part.input ?? {}) as JSONObject,
                        toolCallId: part.toolCallId,
                        toolName: part.toolName,
                        type: "tool-call",
                    });
                    break;
                }

                default: {
                    // Other AI SDK part kinds carry no gateway wire representation.
                    break;
                }
            }
        }
    } catch (error) {
        yield formatSSE({
            error: { code: "STREAM_ERROR", message: error instanceof Error ? error.message : "Unknown stream error" },
            type: "error",
        });
    }
}

/**
 * Format a chunk as an SSE data line.
 */
export const formatSSE = (chunk: StreamChunk): string => `data: ${JSON.stringify(chunk)}\n\n`;
