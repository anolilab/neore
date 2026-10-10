/**
 * Browser-side client for a model server on the user's own machine: the
 * OpenAI-compatible surface both Ollama and LM Studio serve under `/v1`, plus
 * Ollama's native API (`/api/tags`, `/api/pull`, `/api/delete`) for the model
 * manager.
 *
 * Every request goes from the browser straight to loopback — the CSP allows
 * exactly `http://localhost:*` and `http://127.0.0.1:*` in `connect-src` (see
 * `middleware/security-middleware.ts`) — and never through our servers.
 * Failures surface as the raw error; `local-errors.ts` turns them into advice.
 */
import { toLocalServerRoot } from "@neore/ai/models";

import { LocalHttpError } from "./local-errors";
import type { PullProgress } from "./ollama-pull";
import { createLineSplitter, parsePullProgress } from "./ollama-pull";
import { createSseParser, parseChatCompletionChunk } from "./openai-sse";

/** Listing and probing should be instant on loopback; anything slower is not a running server. */
const PROBE_TIMEOUT_MS = 5000;

export interface LocalChatMessage {
    content: string;
    role: "assistant" | "system" | "user";
}

export interface LocalChatResult {
    content: string;
    finishReason?: string;
    reasoning: string;
}

export interface OllamaModelInfo {
    family?: string;
    modifiedAt?: string;
    name: string;
    parameterSize?: string;
    quantization?: string;
    size: number;
}

const readErrorDetail = async (response: Response): Promise<string | undefined> => {
    try {
        const text = await response.text();

        try {
            const json = JSON.parse(text) as { error?: unknown };
            const error = typeof json.error === "string" ? json.error : (json.error as { message?: unknown } | undefined)?.message;

            return typeof error === "string" ? error.slice(0, 300) : undefined;
        } catch {
            return text.trim().slice(0, 300) || undefined;
        }
    } catch {
        return undefined;
    }
};

/** Throws {@link LocalHttpError} for a non-2xx answer, having consumed its body. */
const assertLocalOk = async (response: Response): Promise<Response> => {
    if (!response.ok) {
        throw new LocalHttpError(response.status, await readErrorDetail(response));
    }

    return response;
};

const getJson = async (url: string, fetchImpl: typeof fetch): Promise<unknown> => {
    const response = await assertLocalOk(await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }));

    return await response.json();
};

/** `GET {baseUrl}/models` → model ids, sorted. Both servers answer `{ data: [{ id }] }`. */
export const listLocalModels = async (baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string[]> => {
    const body = (await getJson(`${baseUrl}/models`, fetchImpl)) as { data?: { id?: unknown }[] } | null;
    const ids = (body?.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string" && id.length > 0);

    return [...new Set(ids)].toSorted((a, b) => a.localeCompare(b));
};

/**
 * Ollama's version when the endpoint is Ollama; `undefined` when something
 * ELSE answered (LM Studio has no `/api/version`). A network failure rejects,
 * so the caller can diagnose it instead of mistaking it for "not Ollama".
 */
export const detectOllama = async (baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> => {
    try {
        const body = (await getJson(`${toLocalServerRoot(baseUrl)}/api/version`, fetchImpl)) as { version?: unknown } | null;

        return typeof body?.version === "string" ? body.version : undefined;
    } catch (error) {
        if (error instanceof LocalHttpError || error instanceof SyntaxError) {
            return undefined;
        }

        throw error;
    }
};

/** `GET /api/tags` body → installed models, largest first. */
export const parseOllamaTags = (body: unknown): OllamaModelInfo[] => {
    const models = (body as { models?: unknown } | null)?.models;

    if (!Array.isArray(models)) {
        return [];
    }

    const out: OllamaModelInfo[] = [];

    for (const entry of models) {
        if (!entry || typeof entry !== "object") {
            continue;
        }

        const item = entry as {
            details?: { family?: unknown; parameter_size?: unknown; quantization_level?: unknown };
            model?: unknown;
            modified_at?: unknown;
            name?: unknown;
            size?: unknown;
        };
        const name = [item.name, item.model].find((value): value is string => typeof value === "string" && value.length > 0);

        if (!name) {
            continue;
        }

        const string = (value: unknown) => (typeof value === "string" && value ? value : undefined);

        out.push({
            family: string(item.details?.family),
            modifiedAt: string(item.modified_at),
            name,
            parameterSize: string(item.details?.parameter_size),
            quantization: string(item.details?.quantization_level),
            size: typeof item.size === "number" ? item.size : 0,
        });
    }

    return out.toSorted((a, b) => b.size - a.size || a.name.localeCompare(b.name));
};

export const listOllamaModels = async (baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<OllamaModelInfo[]> =>
    parseOllamaTags(await getJson(`${toLocalServerRoot(baseUrl)}/api/tags`, fetchImpl));

/**
 * `POST /api/pull`, streaming progress to `onProgress`. Resolves on
 * `success`, rejects on an `{ error }` line or a stream that ends without one.
 * No timeout: a multi-GB pull takes as long as it takes; `signal` cancels.
 */
export const pullOllamaModel = async (
    baseUrl: string,
    model: string,
    onProgress: (progress: PullProgress) => void,
    signal?: AbortSignal,
    fetchImpl: typeof fetch = fetch,
): Promise<void> => {
    const response = await assertLocalOk(
        await fetchImpl(`${toLocalServerRoot(baseUrl)}/api/pull`, {
            body: JSON.stringify({ model, stream: true }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal,
        }),
    );

    if (!response.body) {
        throw new Error("The local server sent no progress stream");
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const splitter = createLineSplitter();
    let succeeded = false;

    const handle = (lines: string[]) => {
        for (const line of lines) {
            const progress = parsePullProgress(line);

            if (!progress) {
                continue;
            }

            if (progress.error) {
                throw new Error(progress.error);
            }

            succeeded ||= progress.done;
            onProgress(progress);
        }
    };

    try {
        for (;;) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            handle(splitter.feed(value));
        }

        handle(splitter.flush());
    } finally {
        // Also on an `{ error }` line: stop the server streaming into nothing.
        await reader.cancel().catch(() => undefined);
    }

    if (!succeeded) {
        throw new Error("The pull ended before it finished");
    }
};

export const deleteOllamaModel = async (baseUrl: string, model: string, fetchImpl: typeof fetch = fetch): Promise<void> => {
    const response = await assertLocalOk(
        await fetchImpl(`${toLocalServerRoot(baseUrl)}/api/delete`, {
            body: JSON.stringify({ model }),
            headers: { "content-type": "application/json" },
            method: "DELETE",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
        }),
    );

    await response.body?.cancel();
};

export interface StreamLocalChatOptions {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    messages: LocalChatMessage[];
    model: string;
    onDelta: (delta: { content: string; reasoning: string }) => void;
    signal?: AbortSignal;
}

/**
 * `POST {baseUrl}/chat/completions` with `stream: true`, feeding text to
 * `onDelta` as it arrives. No `tools` are sent — nothing on this path could
 * execute them, and the setup guide tells users so.
 *
 * On abort the promise rejects with the `AbortError`; the caller keeps the
 * text it already received through `onDelta`.
 */
export const streamLocalChat = async ({ baseUrl, fetchImpl = fetch, messages, model, onDelta, signal }: StreamLocalChatOptions): Promise<LocalChatResult> => {
    const response = await assertLocalOk(
        await fetchImpl(`${baseUrl}/chat/completions`, {
            body: JSON.stringify({ messages, model, stream: true }),
            headers: { accept: "text/event-stream", "content-type": "application/json" },
            method: "POST",
            signal,
        }),
    );

    if (!response.body) {
        throw new Error("The local server sent no stream");
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const parser = createSseParser();
    const result: LocalChatResult = { content: "", reasoning: "" };
    let finished = false;

    const handle = (events: ReturnType<typeof parser.feed>) => {
        for (const event of events) {
            if (event.type === "done") {
                finished = true;

                continue;
            }

            const delta = parseChatCompletionChunk(event.data);

            if (delta.content || delta.reasoning) {
                result.content += delta.content;
                result.reasoning += delta.reasoning;
                onDelta({ content: delta.content, reasoning: delta.reasoning });
            }

            if (delta.finishReason) {
                result.finishReason = delta.finishReason;
            }
        }
    };

    try {
        while (!finished) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            handle(parser.feed(value));
        }

        handle(parser.flush());
    } finally {
        // Stop reading on `[DONE]` or an error; do not leave the connection open.
        await reader.cancel().catch(() => undefined);
    }

    return result;
};
