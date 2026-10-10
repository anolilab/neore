/**
 * Deterministic mock language model for local dev and e2e runs.
 *
 * Turned on by `MOCK_LLM=1` and nothing else. When it is on, EVERY language
 * model the gateway builds is this one — the backend keeps asking for its real
 * registry models and every flow (chat, titles, group routing, task
 * verification, memory) runs unchanged, just without a provider key. `mock/echo`
 * is the explicit id for callers that want to name it.
 *
 * It must never answer in production: {@link assertMockLlmAllowed} turns the
 * flag into a hard 500 on every request there, so a leaked env var fails loud
 * instead of silently serving canned replies to real users.
 *
 * Prompt markers (anywhere in the latest user message):
 *   - `[[reasoning]]`                  — emit a reasoning part before the text
 *   - `[[tool:&lt;name> &lt;json>]]`         — call tool `&lt;name>` with `&lt;json>` as input,
 *                                        once; the follow-up turn (after the tool
 *                                        result) answers with plain text
 *   - `[[delay:&lt;ms>]]`                 — wait that long (at most 60s) before
 *                                        answering — a stand-in for a slow model,
 *                                        for measuring concurrency and ordering
 * A call with `responseFormat: { type: "json" }` answers with the smallest
 * object its JSON Schema accepts (booleans `true`, so verifiers pass); a prompt
 * saying "Respond with ONLY a JSON object:" answers its one-line template.
 */
import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    LanguageModelV3Content,
    LanguageModelV3GenerateResult,
    LanguageModelV3Prompt,
    LanguageModelV3StreamPart,
    LanguageModelV3StreamResult,
    LanguageModelV3Usage,
} from "@ai-sdk/provider";

import type { AppEnv } from "../env.js";
import type { ModelPricing } from "./pricing.js";

/** The explicit model id — `provider/modelApiId` in gateway terms. */
export const MOCK_MODEL_ID = "mock/echo";
export const MOCK_PROVIDER = "mock";

/**
 * A fixed price so the per-message cost badge has something to show. Chosen to
 * land every reply in the tens of microdollars — visible, never alarming.
 */
export const MOCK_PRICING: ModelPricing = { contextWindow: 128_000, inputPerMillion: 1, outputPerMillion: 2 };

const TRUTHY = new Set(["1", "on", "true", "yes"]);

/** The env keys the mock gate reads. */
export type MockLlmEnv = Pick<AppEnv, "ENVIRONMENT" | "MOCK_LLM" | "NODE_ENV">;

const isProduction = (env: MockLlmEnv): boolean => env.NODE_ENV === "production" || env.ENVIRONMENT === "production";

const isFlagSet = (env: MockLlmEnv): boolean => TRUTHY.has((env.MOCK_LLM ?? "").trim().toLowerCase());

/** True when the mock replaces every provider for this request. */
export const isMockLlmEnabled = (env: MockLlmEnv): boolean => isFlagSet(env) && !isProduction(env);

/**
 * Throws when `MOCK_LLM` is set in a production environment. Called from a
 * global middleware — Workers have no startup hook with env access, so "fail at
 * startup" means "fail every request" rather than letting one slip through.
 */
export const assertMockLlmAllowed = (env: MockLlmEnv): void => {
    if (isFlagSet(env) && isProduction(env)) {
        throw new Error("MOCK_LLM is set in a production environment. The mock language model is for dev and e2e only — unset MOCK_LLM.");
    }
};

// ── Prompt inspection ────────────────────────────────────────────────────────

const TOOL_MARKER = /\[\[tool:([\w.:-]+)(?:\s+(\{[\s\S]*?\}))?\]\]/;
const REASONING_MARKER = "[[reasoning]]";
const DELAY_MARKER = /\[\[delay:(\d{1,6})\]\]/;
const MAX_DELAY_MS = 60_000;
const WHITESPACE = /\s+/g;

const textOf = (message: LanguageModelV3Prompt[number]): string => {
    if (typeof message.content === "string") {
        return message.content;
    }

    return message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter(Boolean)
        .join(" ");
};

const lastUserText = (prompt: LanguageModelV3Prompt): string => {
    for (let index = prompt.length - 1; index >= 0; index -= 1) {
        const message = prompt[index];

        if (message?.role === "user") {
            return textOf(message);
        }
    }

    return "";
};

/** Tool results that arrived AFTER the latest user message — this turn's, not an earlier one's. */
const toolResultsSinceLastUser = (prompt: LanguageModelV3Prompt): { output: unknown; toolName: string }[] => {
    const results: { output: unknown; toolName: string }[] = [];

    for (let index = prompt.length - 1; index >= 0; index -= 1) {
        const message = prompt[index];

        if (!message || message.role === "user") {
            break;
        }

        if (message.role === "tool") {
            for (const part of message.content) {
                if (part.type === "tool-result") {
                    results.push({ output: part.output, toolName: part.toolName });
                }
            }
        }
    }

    return results;
};

const approxTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const promptTokens = (options: LanguageModelV3CallOptions): number => approxTokens(options.prompt.map((message) => textOf(message)).join(" "));

// ── Structured output ────────────────────────────────────────────────────────

type Schema = {
    $defs?: Record<string, Schema>;
    $ref?: string;
    allOf?: Schema[];
    anyOf?: Schema[];
    const?: unknown;
    default?: unknown;
    definitions?: Record<string, Schema>;
    enum?: unknown[];
    exclusiveMinimum?: number;
    format?: string;
    items?: Schema | Schema[];
    maximum?: number;
    maxLength?: number;
    minimum?: number;
    minItems?: number;
    minLength?: number;
    oneOf?: Schema[];
    properties?: Record<string, Schema>;
    required?: string[];
    type?: string | string[];
};

const MAX_DEPTH = 12;
const LOCAL_REF = /^#\/(?:definitions|\$defs)\/(.+)$/;
const AFTER_SPACE = /(?<= )/;

const resolveRef = (reference: string, root: Schema): Schema | undefined => {
    const match = LOCAL_REF.exec(reference);

    if (!match?.[1]) {
        return reference === "#" ? root : undefined;
    }

    return root.definitions?.[match[1]] ?? root.$defs?.[match[1]];
};

const stringFor = (schema: Schema): string => {
    switch (schema.format) {
        case "date": {
            return "2026-01-01";
        }
        case "date-time": {
            return "2026-01-01T00:00:00.000Z";
        }
        case "email": {
            return "mock@example.com";
        }
        case "uri":
        case "url": {
            return "https://example.com/";
        }
        case "uuid": {
            return "00000000-0000-4000-8000-000000000000";
        }
        default: {
            const base = "Mock response";
            const min = schema.minLength ?? 0;
            const padded = base.length >= min ? base : base.padEnd(min, ".");

            return schema.maxLength === undefined ? padded : padded.slice(0, Math.max(schema.maxLength, 0));
        }
    }
};

/**
 * The smallest value `schema` accepts. Every property is filled (not just the
 * required ones), so consumers reading an optional field still see a value.
 */
export const minimalValueForSchema = (schema: Schema | undefined, root: Schema = schema ?? {}, depth = 0): unknown => {
    if (!schema || depth > MAX_DEPTH) {
        return null;
    }

    if (schema.$ref) {
        return minimalValueForSchema(resolveRef(schema.$ref, root), root, depth + 1);
    }

    if (schema.const !== undefined) {
        return schema.const;
    }

    if (schema.enum && schema.enum.length > 0) {
        return schema.enum[0];
    }

    if (schema.default !== undefined) {
        return schema.default;
    }

    const variants = schema.anyOf ?? schema.oneOf;

    if (variants && variants.length > 0) {
        // Prefer a non-null variant, so `.nullable()` fields still carry data.
        const preferred = variants.find((variant) => variant.type !== "null") ?? variants[0];

        return minimalValueForSchema(preferred, root, depth + 1);
    }

    if (schema.allOf && schema.allOf.length > 0) {
        return Object.assign({}, ...schema.allOf.map((part) => minimalValueForSchema(part, root, depth + 1) as object));
    }

    const type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== "null") ?? schema.type[0]) : schema.type;

    switch (type ?? (schema.properties ? "object" : undefined)) {
        case "object": {
            const result: Record<string, unknown> = {};

            const properties = Object.entries(schema.properties ?? {});

            for (const [key, value] of properties) {
                result[key] = minimalValueForSchema(value, root, depth + 1);
            }

            return result;
        }
        case "array": {
            const count = schema.minItems ?? 0;
            const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;

            return Array.from({ length: count }, () => minimalValueForSchema(itemSchema, root, depth + 1));
        }
        case "string": {
            return stringFor(schema);
        }
        case "integer":
        case "number": {
            if (schema.minimum !== undefined) {
                return schema.minimum;
            }

            if (schema.exclusiveMinimum !== undefined) {
                return (type === "integer" ? Math.floor(schema.exclusiveMinimum) : schema.exclusiveMinimum) + 1;
            }

            return schema.maximum !== undefined && schema.maximum < 1 ? schema.maximum : 1;
        }
        case "boolean": {
            return true;
        }
        case "null": {
            return null;
        }
        default: {
            return null;
        }
    }
};

// ── Prompt-level JSON ────────────────────────────────────────────────────────

/**
 * Some callers ask for JSON in the prompt instead of through `responseFormat` —
 * the task verifier, the eval judge, follow-up suggestions — all with the same
 * phrase followed by a one-line template. Answering those with an echo would
 * fail every verifier, so the template is answered instead.
 */
const JSON_INSTRUCTION = /respond with only a json object/i;
const TEMPLATE_FIELD = /"(\w+)"\s*:\s*([\w[\]]+)/g;

/** The first brace-balanced `{...}` in `text` at or after `from`. */
const balancedObjectAfter = (text: string, from: number): string | undefined => {
    const start = text.indexOf("{", from);

    if (start === -1) {
        return undefined;
    }

    let depth = 0;

    for (let index = start; index < text.length; index += 1) {
        if (text[index] === "{") {
            depth += 1;
        } else if (text[index] === "}") {
            depth -= 1;

            if (depth === 0) {
                return text.slice(start, index + 1);
            }
        }
    }

    return undefined;
};

const valueForTemplateType = (type: string): unknown => {
    if (type.endsWith("[]")) {
        return [];
    }

    switch (type) {
        case "boolean": {
            return true;
        }
        case "integer":
        case "number": {
            return 1;
        }
        case "string": {
            return "";
        }
        default: {
            return "Mock response";
        }
    }
};

/** The object a "Respond with ONLY a JSON object: {...}" instruction asks for, or `undefined` when none does. */
export const answerJsonInstruction = (prompt: LanguageModelV3Prompt): string | undefined => {
    for (const message of prompt) {
        if (message.role !== "system" && message.role !== "user") {
            continue;
        }

        const text = textOf(message);
        const match = JSON_INSTRUCTION.exec(text);
        const template = match ? balancedObjectAfter(text, match.index + match[0].length) : undefined;

        if (!template) {
            continue;
        }

        // A literal example (`{"suggestions": ["q1"]}`) is already valid JSON.
        try {
            JSON.parse(template);

            return template;
        } catch {
            // A type template (`{"pass": boolean}`) — fill each field below.
        }

        const value: Record<string, unknown> = {};

        for (const [, key, type] of template.matchAll(TEMPLATE_FIELD)) {
            if (key && type) {
                value[key] = valueForTemplateType(type);
            }
        }

        return JSON.stringify(value);
    }

    return undefined;
};

// ── Response planning ────────────────────────────────────────────────────────

type MockPlan =
    | { kind: "json"; text: string }
    | { input: string; kind: "tool-call"; toolCallId: string; toolName: string }
    | { kind: "text"; reasoning?: string; text: string };

/** The `[[delay:&lt;ms>]]` a prompt asks for — anywhere in it, so a title or classifier call on the same text waits too — capped. */
export const mockDelayMs = (prompt: LanguageModelV3Prompt): number => {
    for (const message of prompt) {
        const match = DELAY_MARKER.exec(textOf(message));

        if (match?.[1]) {
            return Math.min(Number(match[1]), MAX_DELAY_MS);
        }
    }

    return 0;
};

const waitFor = async (ms: number): Promise<void> => {
    if (ms > 0) {
        await new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
};

/** Short, stable id for a tool call — deterministic so e2e assertions can rely on it. */
const toolCallIdFor = (prompt: LanguageModelV3Prompt, toolName: string): string => `mock-call-${String(prompt.length)}-${toolName}`;

/** Decide the whole response up front; `doGenerate` and `doStream` just render it. */
export const planMockResponse = (options: LanguageModelV3CallOptions): MockPlan => {
    if (options.responseFormat?.type === "json") {
        const value = options.responseFormat.schema ? minimalValueForSchema(options.responseFormat.schema as Schema) : { text: "Mock response" };

        return { kind: "json", text: JSON.stringify(value) };
    }

    const instructedJson = answerJsonInstruction(options.prompt);

    if (instructedJson !== undefined) {
        return { kind: "json", text: instructedJson };
    }

    const userText = lastUserText(options.prompt);
    const results = toolResultsSinceLastUser(options.prompt);
    const toolMatch = TOOL_MARKER.exec(userText);

    if (toolMatch?.[1] && results.length === 0) {
        const toolName = toolMatch[1];
        const available = (options.tools ?? []).some((tool) => tool.name === toolName);

        if (available) {
            return { input: toolMatch[2] ?? "{}", kind: "tool-call", toolCallId: toolCallIdFor(options.prompt, toolName), toolName };
        }

        return { kind: "text", text: `Mock: tool "${toolName}" is not available in this request.` };
    }

    const echo = userText.replace(TOOL_MARKER, "").replace(REASONING_MARKER, "").replace(DELAY_MARKER, "").replaceAll(WHITESPACE, " ").trim();
    const echoed = echo.length > 0 ? echo.slice(0, 200) : "(empty prompt)";
    const text =
        results.length > 0
            ? `Mock: tool ${results.map((result) => result.toolName).join(", ")} finished. Continuing after the tool result.`
            : `Mock reply: ${echoed}`;
    const reasoning = userText.includes(REASONING_MARKER) ? "Mock reasoning: considering the request step by step." : undefined;

    return { kind: "text", text, ...(reasoning && { reasoning }) };
};

const usageFor = (options: LanguageModelV3CallOptions, plan: MockPlan): LanguageModelV3Usage => {
    const input = promptTokens(options);
    const reasoning = plan.kind === "text" && plan.reasoning ? approxTokens(plan.reasoning) : 0;
    const visible = approxTokens(plan.kind === "tool-call" ? plan.input : plan.text);

    return {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: input, total: input },
        outputTokens: { reasoning, text: visible, total: visible + reasoning },
    };
};

const finishReasonFor = (plan: MockPlan): LanguageModelV3GenerateResult["finishReason"] =>
    plan.kind === "tool-call" ? { raw: "tool_calls", unified: "tool-calls" } : { raw: "stop", unified: "stop" };

/** Split into a few chunks so the client sees a real stream, not one delta. */
const chunk = (text: string): string[] => {
    const words = text.split(AFTER_SPACE);
    const size = Math.max(1, Math.ceil(words.length / 4));
    const parts: string[] = [];

    for (let index = 0; index < words.length; index += size) {
        parts.push(words.slice(index, index + size).join(""));
    }

    return parts;
};

const renderStream = (plan: MockPlan, usage: LanguageModelV3Usage, modelId: string): LanguageModelV3StreamPart[] => {
    const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { id: "mock-response", modelId, timestamp: new Date(0), type: "response-metadata" },
    ];

    if (plan.kind === "tool-call") {
        parts.push(
            { id: plan.toolCallId, toolName: plan.toolName, type: "tool-input-start" },
            { delta: plan.input, id: plan.toolCallId, type: "tool-input-delta" },
            { id: plan.toolCallId, type: "tool-input-end" },
            { input: plan.input, toolCallId: plan.toolCallId, toolName: plan.toolName, type: "tool-call" },
        );
    } else {
        if (plan.kind === "text" && plan.reasoning) {
            parts.push({ id: "mock-reasoning", type: "reasoning-start" });

            for (const delta of chunk(plan.reasoning)) {
                parts.push({ delta, id: "mock-reasoning", type: "reasoning-delta" });
            }

            parts.push({ id: "mock-reasoning", type: "reasoning-end" });
        }

        parts.push({ id: "mock-text", type: "text-start" });

        for (const delta of chunk(plan.text)) {
            parts.push({ delta, id: "mock-text", type: "text-delta" });
        }

        parts.push({ id: "mock-text", type: "text-end" });
    }

    parts.push({ finishReason: finishReasonFor(plan), type: "finish", usage });

    return parts;
};

const renderContent = (plan: MockPlan): LanguageModelV3Content[] => {
    if (plan.kind === "tool-call") {
        return [{ input: plan.input, toolCallId: plan.toolCallId, toolName: plan.toolName, type: "tool-call" }];
    }

    const content: LanguageModelV3Content[] = [];

    if (plan.kind === "text" && plan.reasoning) {
        content.push({ text: plan.reasoning, type: "reasoning" });
    }

    content.push({ text: plan.text, type: "text" });

    return content;
};

/**
 * Build the mock. `modelId` is only echoed back in response metadata — the
 * behaviour is identical whichever model the caller asked for.
 */
export const createMockLanguageModel = (modelId: string = MOCK_MODEL_ID): LanguageModelV3 => {
    return {
        doGenerate: async (options) => {
            await waitFor(mockDelayMs(options.prompt));

            const plan = planMockResponse(options);

            return {
                content: renderContent(plan),
                finishReason: finishReasonFor(plan),
                response: { id: "mock-response", modelId, timestamp: new Date(0) },
                usage: usageFor(options, plan),
                warnings: [],
            };
        },
        doStream: async (options): Promise<LanguageModelV3StreamResult> => {
            await waitFor(mockDelayMs(options.prompt));

            const plan = planMockResponse(options);
            const parts = renderStream(plan, usageFor(options, plan), modelId);

            return {
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                    start(controller) {
                        for (const part of parts) {
                            controller.enqueue(part);
                        }

                        controller.close();
                    },
                }),
            };
        },
        modelId,
        provider: MOCK_PROVIDER,
        specificationVersion: "v3",
        supportedUrls: {},
    };
};
