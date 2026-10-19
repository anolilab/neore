/**
 * Pure translators between the OpenAI Responses API and the Chat Completions
 * body that `routes/v1/completions.ts` already serves. No I/O: the route file
 * dispatches in-process, these functions only reshape.
 *
 * Refusals throw {@link ResponsesRequestError} with the offending `param`, so
 * the route answers 400 before anything reaches a provider.
 */
import { z } from "zod";

import { ResponsesRequestError } from "./responses-request-error.js";

/** A Chat Completions request body, as far as this translator emits it. */
export interface ChatRequestBody {
    max_tokens?: number;
    messages: ChatMessage[];
    model: string;
    response_format?: { type: "json_object" } | { json_schema: Record<string, unknown>; type: "json_schema" };
    stream: boolean;
    /** Streams end with a usage chunk only when asked, and `response.completed` needs it. */
    stream_options?: { include_usage: true };
    temperature?: number;
    tool_choice?: "auto" | "none" | "required" | { function: { name: string }; type: "function" };
    tools?: ChatTool[];
    top_p?: number;
}

export type ChatMessage =
    | { content: string; role: "system" | "user" }
    | { content: string; role: "assistant"; tool_calls?: ChatToolCall[] }
    | { content: string; role: "tool"; tool_call_id: string };

export interface ChatToolCall {
    function: { arguments: string; name: string };
    id: string;
    type: "function";
}

export interface ChatTool {
    function: { description?: string; name: string; parameters?: Record<string, unknown> };
    type: "function";
}

interface ChatUsage {
    completion_tokens: number;
    prompt_tokens: number;
    total_tokens: number;
}

/** A non-streaming `chat.completion` as the completions route returns it. */
export interface ChatCompletion {
    choices: { finish_reason: string | null; message: { content: string | null; tool_calls?: ChatToolCall[] } }[];
    created: number;
    id?: string;
    model: string;
    usage?: ChatUsage;
}

/** One `chat.completion.chunk` SSE frame, or the `{ error }` frame the stream sends on failure. */
export interface ChatCompletionChunk {
    choices?: { delta?: { content?: string | null; tool_calls?: PartialToolCall[] }; finish_reason?: string | null }[];
    error?: { message?: string };
    /** The routed model, which a fallback or router may make differ from the one requested. */
    model?: string;
    usage?: ChatUsage;
}

interface PartialToolCall {
    function?: { arguments?: string; name?: string };
    id?: string;
    index?: number;
}

export interface ResponseUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
}

export interface ResponseMessageItem {
    content: { annotations: []; text: string; type: "output_text" }[];
    id: string;
    role: "assistant";
    status: "completed";
    type: "message";
}

export interface ResponseFunctionCallItem {
    arguments: string;
    call_id: string;
    id: string;
    name: string;
    status: "completed";
    type: "function_call";
}

export type ResponseOutputItem = ResponseMessageItem | ResponseFunctionCallItem;

export interface ResponseObject {
    created_at: number;
    error: { code: string; message: string } | null;
    id: string;
    incomplete_details: { reason: string } | null;
    model: string;
    object: "response";
    output: ResponseOutputItem[];
    status: "completed" | "failed" | "in_progress" | "incomplete";
    usage: ResponseUsage | null;
}

/** A Responses stream event. Every event carries a `type` and a `sequence_number`. */
export type ResponseStreamEvent = Record<string, unknown> & { sequence_number: number; type: string };

export interface ResponsesErrorBody {
    error: { code: string | null; message: string; param: string | null; type: string };
}

const refusal = (message: string, path: string | null): ResponsesRequestError => new ResponsesRequestError(message, path);

export const isResponsesRequestError = (error: unknown): error is ResponsesRequestError => error instanceof ResponsesRequestError;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 29)}`;

/** Parses `value` or throws a 400 whose `param` is the first failing path, prefixed by `prefix`. */
const parseOrThrow = <T>(schema: z.ZodType<T>, value: unknown, prefix: string): T => {
    const result = schema.safeParse(value);

    if (result.success) {
        return result.data;
    }

    const issue = result.error.issues[0];
    const path = [prefix, ...issue.path.map(String)].filter((part) => part !== "").join(".") || null;

    throw refusal(`${path ?? "request body"}: ${issue.message}`, path);
};

// ---------------------------------------------------------------------------
// Request: Responses -> Chat Completions
// ---------------------------------------------------------------------------

/** Top-level fields that need server-side state or background work, which the gateway does not keep. */
const STATEFUL_FIELDS = ["previous_response_id", "conversation"] as const;

const TEXT_PART_TYPES = new Set(["input_text", "output_text", "text"]);

const requestSchema = z.object({
    background: z.unknown().optional(),
    conversation: z.unknown().optional(),
    input: z.union([z.string(), z.array(z.unknown())]),
    instructions: z.string().nullish(),
    max_output_tokens: z.int().positive().optional(),
    model: z.string(),
    previous_response_id: z.unknown().optional(),
    stream: z.boolean().nullish(),
    temperature: z.number().optional(),
    text: z
        .object({
            format: z.object({ name: z.string().optional(), schema: z.record(z.string(), z.unknown()).optional(), type: z.string() }).nullish(),
        })
        .nullish(),
    tool_choice: z.union([z.enum(["auto", "none", "required"]), z.object({ name: z.string(), type: z.literal("function") })]).nullish(),
    tools: z.array(z.unknown()).nullish(),
    top_p: z.number().optional(),
});

const messageItemSchema = z.object({
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
    role: z.enum(["system", "developer", "user", "assistant"]),
});

const functionCallItemSchema = z.object({ arguments: z.string(), call_id: z.string(), name: z.string() });

const functionCallOutputSchema = z.object({
    call_id: z.string(),
    output: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
});

const functionToolSchema = z.object({
    description: z.string().nullish(),
    name: z.string(),
    parameters: z.record(z.string(), z.unknown()).nullish(),
    type: z.literal("function"),
});

/** Joins the text of a parts array. Any non-text part is refused, naming `prefix[i].type`. */
const partsText = (parts: Record<string, unknown>[], prefix: string): string =>
    parts
        .map((part, index) => {
            if (typeof part.type !== "string" || !TEXT_PART_TYPES.has(part.type) || typeof part.text !== "string") {
                const path = `${prefix}[${index}].type`;

                throw refusal(`${path} '${String(part.type)}' is not supported: only text parts are`, path);
            }

            return part.text;
        })
        .join("\n");

const translateMessageItem = (raw: Record<string, unknown>, at: string): ChatMessage => {
    const item = parseOrThrow(messageItemSchema, raw, at);
    const content = typeof item.content === "string" ? item.content : partsText(item.content, `${at}.content`);

    // Chat Completions has no developer role; its instructions are the system role.
    return { content, role: item.role === "developer" ? "system" : item.role };
};

/** Consecutive function calls join the assistant message they follow, as one chat `tool_calls` list. */
const appendToolCall = (messages: ChatMessage[], item: { arguments: string; call_id: string; name: string }): void => {
    const call: ChatToolCall = { function: { arguments: item.arguments, name: item.name }, id: item.call_id, type: "function" };
    const last = messages.at(-1);

    if (last?.role === "assistant") {
        last.tool_calls = [...(last.tool_calls ?? []), call];

        return;
    }

    messages.push({ content: "", role: "assistant", tool_calls: [call] });
};

const translateInput = (input: string | unknown[]): ChatMessage[] => {
    if (typeof input === "string") {
        return [{ content: input, role: "user" }];
    }

    const messages: ChatMessage[] = [];

    input.forEach((raw, index) => {
        const at = `input[${index}]`;

        if (!isRecord(raw)) {
            throw refusal(`${at} must be an object`, at);
        }

        // Items without a `type` but with a `role` are the easy-input message form.
        const type = typeof raw.type === "string" ? raw.type : "message";

        switch (type) {
            case "function_call": {
                appendToolCall(messages, parseOrThrow(functionCallItemSchema, raw, at));
                break;
            }

            case "function_call_output": {
                const item = parseOrThrow(functionCallOutputSchema, raw, at);

                messages.push({
                    content: typeof item.output === "string" ? item.output : partsText(item.output, `${at}.output`),
                    role: "tool",
                    tool_call_id: item.call_id,
                });
                break;
            }

            case "message": {
                messages.push(translateMessageItem(raw, at));
                break;
            }

            case "reasoning": {
                // Reasoning items from earlier turns are encrypted provider state with no chat equivalent.
                break;
            }

            default: {
                throw refusal(`${at}.type '${type}' is not supported`, `${at}.type`);
            }
        }
    });

    return messages;
};

const translateTools = (tools: unknown[] | null | undefined): ChatTool[] | undefined => {
    if (!tools || tools.length === 0) {
        return undefined;
    }

    return tools.map((raw, index) => {
        const type = isRecord(raw) ? raw.type : undefined;

        if (type !== "function") {
            const path = `tools[${index}].type`;

            throw refusal(`${path} '${String(type)}' is a hosted tool; the gateway serves only "function" tools`, path);
        }

        const tool = parseOrThrow(functionToolSchema, raw, `tools[${index}]`);

        return {
            function: {
                ...(tool.description && { description: tool.description }),
                name: tool.name,
                ...(tool.parameters && { parameters: tool.parameters }),
            },
            type: "function",
        };
    });
};

const translateResponseFormat = (text: z.infer<typeof requestSchema>["text"]): ChatRequestBody["response_format"] => {
    const format = text?.format;

    if (!format || format.type === "text") {
        return undefined;
    }

    if (format.type === "json_object") {
        return { type: "json_object" };
    }

    if (format.type === "json_schema") {
        if (!format.schema) {
            throw refusal("text.format.schema: required for json_schema", "text.format.schema");
        }

        return { json_schema: format.schema, type: "json_schema" };
    }

    throw refusal(`text.format.type '${format.type}' is not supported`, "text.format.type");
};

/**
 * Translate a Responses request body into the Chat Completions body the
 * completions route accepts. Throws {@link ResponsesRequestError} on anything
 * it cannot honour. Fields with no gateway meaning (`store`, `metadata`,
 * `include`, `parallel_tool_calls`, ...) are ignored, as zod strips them.
 */
export const translateRequest = (raw: unknown): ChatRequestBody => {
    if (!isRecord(raw)) {
        throw refusal("request body: must be a JSON object", null);
    }

    for (const field of STATEFUL_FIELDS) {
        if (raw[field] !== undefined && raw[field] !== null) {
            throw refusal(`${field} is not supported: the gateway stores no responses, so send the full conversation in input`, field);
        }
    }

    if (raw.background === true) {
        throw refusal("background is not supported: requests run synchronously", "background");
    }

    const body = parseOrThrow(requestSchema, raw, "");
    const messages: ChatMessage[] = [];

    if (body.instructions) {
        messages.push({ content: body.instructions, role: "system" });
    }

    messages.push(...translateInput(body.input));

    const tools = translateTools(body.tools);
    const responseFormat = translateResponseFormat(body.text);
    const toolChoice = body.tool_choice;

    return {
        messages,
        model: body.model,
        stream: body.stream === true,
        ...(body.stream === true && { stream_options: { include_usage: true as const } }),
        ...(body.max_output_tokens !== undefined && { max_tokens: body.max_output_tokens }),
        ...(body.temperature !== undefined && { temperature: body.temperature }),
        ...(toolChoice && { tool_choice: typeof toolChoice === "string" ? toolChoice : { function: { name: toolChoice.name }, type: "function" as const } }),
        ...(body.top_p !== undefined && { top_p: body.top_p }),
        ...(tools && { tools }),
        ...(responseFormat && { response_format: responseFormat }),
    };
};

// ---------------------------------------------------------------------------
// Response: Chat Completions -> Responses
// ---------------------------------------------------------------------------

/** The `incomplete` reason for a chat finish reason, or null when the reply ran to its natural end. */
const incompleteReason = (finishReason: string | null): string | null => {
    if (finishReason === "length") {
        return "max_output_tokens";
    }

    return finishReason === "content_filter" ? "content_filter" : null;
};

/** The terminal status: a failure wins, otherwise a `length` or `content_filter` stop is incomplete. */
const terminalStatus = (isFailed: boolean, reason: string | null): "completed" | "failed" | "incomplete" => {
    if (isFailed) {
        return "failed";
    }

    return reason === null ? "completed" : "incomplete";
};

const toUsage = (usage: ChatUsage): ResponseUsage => {
    return {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
    };
};

const outputMessage = (text: string, id: string = newId("msg")): ResponseMessageItem => {
    return {
        content: [{ annotations: [], text, type: "output_text" }],
        id,
        role: "assistant",
        status: "completed",
        type: "message",
    };
};

const outputFunctionCall = (callId: string, name: string, args: string, id: string = newId("fc")): ResponseFunctionCallItem => {
    return {
        arguments: args,
        call_id: callId,
        id,
        name,
        status: "completed",
        type: "function_call",
    };
};

const CHAT_COMPLETION_PREFIX = /^chatcmpl-/;

/** `chatcmpl-abc` -> `resp_abc`. A random id only when the completion carries none. */
const responseIdOf = (completionId: string | undefined): string => {
    const suffix = completionId?.replace(CHAT_COMPLETION_PREFIX, "");

    return suffix ? `resp_${suffix}` : newId("resp");
};

/** A non-streaming chat completion as a Responses object. */
export const chatCompletionToResponse = (completion: ChatCompletion): ResponseObject => {
    const choice = completion.choices[0];
    const text = choice?.message.content ?? "";
    const calls = choice?.message.tool_calls ?? [];
    const output: ResponseOutputItem[] = [];

    if (text !== "" || calls.length === 0) {
        output.push(outputMessage(text));
    }

    for (const call of calls) {
        output.push(outputFunctionCall(call.id, call.function.name, call.function.arguments));
    }

    const reason = incompleteReason(choice?.finish_reason ?? null);

    return {
        created_at: completion.created,
        error: null,
        // Derived from the completion's id, so a replayed (idempotent) reply keeps its id.
        id: responseIdOf(completion.id),
        incomplete_details: reason === null ? null : { reason },
        model: completion.model,
        object: "response",
        output,
        status: terminalStatus(false, reason),
        usage: completion.usage ? toUsage(completion.usage) : null,
    };
};

// ---------------------------------------------------------------------------
// Streaming: chat chunks -> Responses events
// ---------------------------------------------------------------------------

interface OpenMessage {
    id: string;
    kind: "message";
    outputIndex: number;
    text: string;
}

interface OpenFunctionCall {
    args: string;
    callId: string;
    id: string;
    kind: "function_call";
    name: string;
    outputIndex: number;
}

/**
 * Turns chat chunks into Responses events, one at a time. Only one output item
 * is open at once, so an item's `output_index` is the length of `output` when
 * it opens. Failure is sticky: a later `stop` cannot turn a failed reply into a
 * completed one.
 */
export class ResponsesStreamTranslator {
    private failure: string | null = null;

    private finished = false;

    private finishReason: string | null = null;

    /** The routed model, from the first chunk that names one. Until then, the requested model. */
    private model: string | null = null;

    private open: OpenMessage | OpenFunctionCall | null = null;

    private readonly output: ResponseOutputItem[] = [];

    private readonly requestedModel: string;

    private sequence = 0;

    private readonly createdAt = Math.floor(Date.now() / 1000);

    private readonly id = newId("resp");

    private usage: ResponseUsage | null = null;

    constructor(requestedModel: string) {
        this.requestedModel = requestedModel;
    }

    start(): ResponseStreamEvent[] {
        return [this.emit("response.created", { response: this.snapshot("in_progress", null, null) })];
    }

    push(chunk: ChatCompletionChunk): ResponseStreamEvent[] {
        if (chunk.model) {
            this.model ??= chunk.model;
        }

        if (chunk.error) {
            this.failure ??= chunk.error.message ?? "The model provider failed while streaming.";

            return [];
        }

        if (chunk.usage) {
            this.usage = toUsage(chunk.usage);
        }

        const events: ResponseStreamEvent[] = [];
        const choices = chunk.choices ?? [];

        for (const choice of choices) {
            const delta = choice.delta ?? {};
            const calls = delta.tool_calls ?? [];

            if (delta.content) {
                events.push(...this.text(delta.content));
            }

            for (const call of calls) {
                events.push(...this.toolCall(call));
            }

            if (choice.finish_reason === "error") {
                this.failure ??= "The model provider failed while streaming.";
            } else if (choice.finish_reason) {
                this.finishReason = choice.finish_reason;
            }
        }

        return events;
    }

    text(content: string): ResponseStreamEvent[] {
        const events: ResponseStreamEvent[] = [];
        const message = this.ensureMessage(events);

        message.text += content;
        events.push(
            this.emit("response.output_text.delta", {
                content_index: 0,
                delta: content,
                item_id: message.id,
                logprobs: [],
                output_index: message.outputIndex,
            }),
        );

        return events;
    }

    toolCall(call: PartialToolCall): ResponseStreamEvent[] {
        const events: ResponseStreamEvent[] = [];
        const current = this.open?.kind === "function_call" ? this.open : null;

        // Completions sends each call whole, numbered in stream order, so calls are told apart by id.
        // A delta without an id continues the open call.
        const item =
            current !== null && (call.id === undefined || call.id === current.callId)
                ? current
                : this.openFunctionCall(events, call.id ?? newId("call"), call.function?.name ?? "");
        const args = call.function?.arguments ?? "";

        if (args !== "") {
            item.args += args;
            events.push(this.emit("response.function_call_arguments.delta", { delta: args, item_id: item.id, output_index: item.outputIndex }));
        }

        return events;
    }

    ensureMessage(events: ResponseStreamEvent[]): OpenMessage {
        if (this.open?.kind === "message") {
            return this.open;
        }

        events.push(...this.closeOpen());

        const message: OpenMessage = { id: newId("msg"), kind: "message", outputIndex: this.output.length, text: "" };

        this.open = message;
        events.push(
            this.emit("response.output_item.added", {
                item: { content: [], id: message.id, role: "assistant", status: "in_progress", type: "message" },
                output_index: message.outputIndex,
            }),
            this.emit("response.content_part.added", {
                content_index: 0,
                item_id: message.id,
                output_index: message.outputIndex,
                part: { annotations: [], text: "", type: "output_text" },
            }),
        );

        return message;
    }

    openFunctionCall(events: ResponseStreamEvent[], callId: string, name: string): OpenFunctionCall {
        events.push(...this.closeOpen());

        const call: OpenFunctionCall = { args: "", callId, id: newId("fc"), kind: "function_call", name, outputIndex: this.output.length };

        this.open = call;
        events.push(
            this.emit("response.output_item.added", {
                item: { arguments: "", call_id: callId, id: call.id, name, status: "in_progress", type: "function_call" },
                output_index: call.outputIndex,
            }),
        );

        return call;
    }

    closeOpen(): ResponseStreamEvent[] {
        const { open } = this;

        if (open === null) {
            return [];
        }

        this.open = null;

        if (open.kind === "message") {
            const part = { annotations: [], text: open.text, type: "output_text" as const };
            const item = outputMessage(open.text, open.id);

            this.output.push(item);

            return [
                this.emit("response.output_text.done", {
                    content_index: 0,
                    item_id: open.id,
                    logprobs: [],
                    output_index: open.outputIndex,
                    text: open.text,
                }),
                this.emit("response.content_part.done", { content_index: 0, item_id: open.id, output_index: open.outputIndex, part }),
                this.emit("response.output_item.done", { item, output_index: open.outputIndex }),
            ];
        }

        const item = outputFunctionCall(open.callId, open.name, open.args, open.id);

        this.output.push(item);

        return [
            this.emit("response.function_call_arguments.done", { arguments: open.args, item_id: open.id, output_index: open.outputIndex }),
            this.emit("response.output_item.done", { item, output_index: open.outputIndex }),
        ];
    }

    snapshot(status: ResponseObject["status"], incomplete: { reason: string } | null, failure: string | null): ResponseObject {
        return {
            created_at: this.createdAt,
            error: failure === null ? null : { code: "server_error", message: failure },
            id: this.id,
            incomplete_details: incomplete,
            model: this.model ?? this.requestedModel,
            object: "response",
            output: [...this.output],
            status,
            usage: this.usage,
        };
    }

    emit(type: string, data: Record<string, unknown>): ResponseStreamEvent {
        const event = { ...data, sequence_number: this.sequence, type };

        this.sequence += 1;

        return event;
    }

    /** Closes the open item and emits the terminal event. Only the first call does anything. */
    finish(): ResponseStreamEvent[] {
        if (this.finished) {
            return [];
        }

        this.finished = true;

        const events = this.closeOpen();
        // No finish_reason and no error frame means the upstream stopped early. That is not a completed reply.
        const reason = this.finishReason === null && this.failure === null ? "stream_ended" : incompleteReason(this.finishReason);
        const status = terminalStatus(this.failure !== null, reason);
        const incomplete = status === "incomplete" && reason !== null ? { reason } : null;
        const response = this.snapshot(status, incomplete, this.failure);

        events.push(this.emit(`response.${status}`, { response }));

        return events;
    }
}

/** One SSE frame for a Responses event: `event:` names the type, as the Responses API does. */
export const encodeSseEvent = (event: ResponseStreamEvent): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const LEADING_SPACE = /^ /;

/**
 * Splits complete SSE frames out of `buffer`. Returns each frame's `data:`
 * payload and the unfinished tail to keep for the next chunk.
 */
export const takeSseData = (buffer: string): { data: string[]; rest: string } => {
    const frames = buffer.split("\n\n");
    const rest = frames.pop() ?? "";
    const data: string[] = [];

    for (const frame of frames) {
        const payload = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(LEADING_SPACE, ""))
            .join("\n");

        if (payload !== "") {
            data.push(payload);
        }
    }

    return { data, rest };
};

/**
 * Feeds the complete frames in `buffer` through the translator and returns the
 * events they produced, with the unfinished tail. `[DONE]` and unparseable
 * payloads are skipped.
 */
const drain = (translator: ResponsesStreamTranslator, buffer: string): { events: ResponseStreamEvent[]; rest: string } => {
    const { data, rest } = takeSseData(buffer);
    const events: ResponseStreamEvent[] = [];

    for (const payload of data) {
        if (payload === "[DONE]") {
            continue;
        }

        let chunk: ChatCompletionChunk;

        try {
            chunk = JSON.parse(payload) as ChatCompletionChunk;
        } catch {
            continue;
        }

        events.push(...translator.push(chunk));
    }

    return { events, rest };
};

/**
 * A transform from the completions route's chat SSE bytes to Responses SSE
 * bytes. Frames split across chunks are buffered. Cancelling the readable side
 * cancels the upstream read, which is how a client disconnect reaches the
 * provider call.
 */
export const createResponsesStream = (model: string): TransformStream<Uint8Array, Uint8Array> => {
    const translator = new ResponsesStreamTranslator(model);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    const write = (controller: TransformStreamDefaultController<Uint8Array>, events: ResponseStreamEvent[]): void => {
        for (const event of events) {
            controller.enqueue(encoder.encode(encodeSseEvent(event)));
        }
    };

    return new TransformStream<Uint8Array, Uint8Array>({
        flush(controller) {
            // The last frame may arrive without its blank line.
            const drained = drain(translator, `${buffer}${decoder.decode()}\n\n`);

            write(controller, drained.events);
            write(controller, translator.finish());
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        },
        start(controller) {
            write(controller, translator.start());
        },
        transform(chunk, controller) {
            const drained = drain(translator, buffer + decoder.decode(chunk, { stream: true }));

            buffer = drained.rest;
            write(controller, drained.events);
        },
    });
};

/**
 * The upstream body, ended by a terminal frame when it errors. A TransformStream
 * never flushes once its input errors, so the error is turned into the chat
 * `{ error }` frame the translator maps to `response.failed`. The leading blank
 * line closes a frame that was cut off mid-line.
 */
export const endOnReadError = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
    const reader = body.getReader();
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        async cancel(reason) {
            await reader.cancel(reason);
        },
        async pull(controller) {
            try {
                const { done, value } = await reader.read();

                if (done) {
                    controller.close();

                    return;
                }

                controller.enqueue(value);
            } catch {
                controller.enqueue(encoder.encode(`\n\ndata: ${JSON.stringify({ error: { message: "The model provider stream was interrupted." } })}\n\n`));
                controller.close();
            }
        },
    });
};

// ---------------------------------------------------------------------------
// Errors and headers
// ---------------------------------------------------------------------------

export const responsesError = (message: string, options: { code?: string | null; param?: string | null; type?: string } = {}): ResponsesErrorBody => {
    return {
        error: {
            code: options.code ?? null,
            message,
            param: options.param ?? null,
            type: options.type ?? "invalid_request_error",
        },
    };
};

/**
 * Re-wraps an upstream error in the Responses error shape. The upstream's
 * message is used only when its body is the completions JSON error; anything
 * else gets a generic message, so raw provider text never reaches the client.
 */
export const upstreamError = (status: number, text: string): ResponsesErrorBody => {
    const type = status >= 500 ? "server_error" : "invalid_request_error";
    const generic = `Upstream request failed with status ${status}.`;

    try {
        const parsed: unknown = JSON.parse(text);
        const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;

        if (error && typeof error.message === "string") {
            return responsesError(error.message, { code: typeof error.code === "string" ? error.code : null, type });
        }
    } catch {
        // Not JSON: fall through to the generic message.
    }

    return responsesError(generic, { type });
};

/** The headers a Responses reply keeps from the completions reply: gateway diagnostics and retry hints. */
export const passthroughHeaders = (headers: Headers): Record<string, string> => {
    const kept: Record<string, string> = {};

    headers.forEach((value, name) => {
        if (name === "retry-after" || name.startsWith("x-")) {
            kept[name] = value;
        }
    });

    return kept;
};
