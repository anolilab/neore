/**
 * Provider adapter interface for format conversion between
 * OpenAI-compatible format and provider-native formats.
 *
 * Used when making direct API calls that bypass AI SDK adapters
 * (e.g., for prompt caching, native streaming, or performance).
 */
import type { JSONObject } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";

export interface AdapterOptions {
    maxTokens?: number;
    providerOptions?: Record<string, JSONObject>;
    temperature?: number;
    tools?: ToolDefinition[];
}

export interface ToolDefinition {
    cache_control?: { type: "ephemeral" };
    description: string;
    name: string;
    /** JSON Schema for the tool arguments. Carried through untouched, so it is never inspected here. */
    parameters: unknown;
}

export interface ProviderRequest {
    body: JSONObject;
    headers?: Record<string, string>;
}

export interface StandardResponse {
    finishReason: string;
    model: string;
    text: string;
    usage: {
        cachedTokens?: number;
        completionTokens: number;
        promptTokens: number;
        reasoningTokens?: number;
    };
}

export interface ProviderAdapter {
    /** Convert OpenAI-format messages to provider-native format */
    transformRequest: (messages: ModelMessage[], options: AdapterOptions) => ProviderRequest;
    /** Convert provider-native response back to standard format */
    transformResponse: (response: JSONObject) => StandardResponse;
}
