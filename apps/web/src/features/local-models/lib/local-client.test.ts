import { describe, expect, it, vi } from "vitest";

import { deleteOllamaModel, detectOllama, listLocalModels, parseOllamaTags, pullOllamaModel, streamLocalChat } from "./local-client";
import { LocalHttpError } from "./local-errors";

const BASE = ["http", "//localhost:11434/v1"].join(":");

/** A Response whose body arrives in the given chunks — the network's boundaries, not ours. */
const streamed = (chunks: string[], init: ResponseInit = {}) => {
    const encoder = new TextEncoder();

    return new Response(
        new ReadableStream({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(encoder.encode(chunk));
                }

                controller.close();
            },
        }),
        init,
    );
};

const sse = (...contents: string[]) => [...contents.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`), "data: [DONE]\n\n"];

describe(streamLocalChat, () => {
    it("posts an OpenAI-compatible request without tools and streams the text", async () => {
        expect.assertions(4);

        const fetchImpl = vi.fn(async () => streamed(sse("Hel", "lo")));
        const deltas: string[] = [];
        const result = await streamLocalChat({
            baseUrl: BASE,
            fetchImpl: fetchImpl as never,
            messages: [{ content: "hi", role: "user" }],
            model: "llama3.2:3b",
            onDelta: (delta) => {
                deltas.push(delta.content);
            },
        });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe(`${BASE}/chat/completions`);
        expect(JSON.parse(init.body as string)).toStrictEqual({ messages: [{ content: "hi", role: "user" }], model: "llama3.2:3b", stream: true });
        expect(deltas).toStrictEqual(["Hel", "lo"]);
        expect(result.content).toBe("Hello");
    });

    it("throws the server's error text for a non-2xx answer", async () => {
        expect.assertions(2);

        const fetchImpl = async () => Response.json({ error: 'model "nope" not found, try pulling it first' }, { status: 404 });
        const run = streamLocalChat({ baseUrl: BASE, fetchImpl: fetchImpl as never, messages: [], model: "nope", onDelta: () => undefined });

        await expect(run).rejects.toBeInstanceOf(LocalHttpError);
        await expect(run).rejects.toThrow("not found, try pulling it first");
    });
});

describe(listLocalModels, () => {
    it("reads and de-duplicates model ids", async () => {
        expect.assertions(1);

        const fetchImpl = async () => Response.json({ data: [{ id: "qwen3:8b" }, { id: "llama3.2:3b" }, { id: "qwen3:8b" }, { nope: 1 }], object: "list" });

        await expect(listLocalModels(BASE, fetchImpl as never)).resolves.toStrictEqual(["llama3.2:3b", "qwen3:8b"]);
    });
});

describe(parseOllamaTags, () => {
    it("keeps size and quantisation, largest first", () => {
        expect.assertions(1);
        expect(
            parseOllamaTags({
                models: [
                    {
                        details: { family: "llama", parameter_size: "3.2B", quantization_level: "Q4_K_M" },
                        model: "llama3.2:3b",
                        name: "llama3.2:3b",
                        size: 2_019_393_189,
                    },
                    { details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" }, name: "qwen3:8b", size: 5_225_376_047 },
                    { size: 1 },
                ],
            }),
        ).toStrictEqual([
            { family: undefined, modifiedAt: undefined, name: "qwen3:8b", parameterSize: "8.2B", quantization: "Q4_K_M", size: 5_225_376_047 },
            { family: "llama", modifiedAt: undefined, name: "llama3.2:3b", parameterSize: "3.2B", quantization: "Q4_K_M", size: 2_019_393_189 },
        ]);
    });

    it("answers [] for anything else", () => {
        expect.assertions(1);
        expect(parseOllamaTags({ data: [] })).toStrictEqual([]);
    });
});

describe(pullOllamaModel, () => {
    it("streams progress from the server root and resolves on success", async () => {
        expect.assertions(3);

        const fetchImpl = vi.fn(async () =>
            streamed(['{"status":"pulling manifest"}\n{"status":"pulling ab","total":100,"com', 'pleted":40}\n', '{"status":"success"}\n']),
        );
        const statuses: string[] = [];

        await pullOllamaModel(
            BASE,
            "llama3.2:3b",
            (progress) => {
                statuses.push(`${progress.status}:${progress.percent ?? "-"}`);
            },
            undefined,
            fetchImpl as never,
        );

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe("http://localhost:11434/api/pull");
        expect(JSON.parse(init.body as string)).toStrictEqual({ model: "llama3.2:3b", stream: true });
        expect(statuses).toStrictEqual(["pulling manifest:-", "pulling ab:40", "success:-"]);
    });

    it("rejects on an error line and on a stream that never reports success", async () => {
        expect.assertions(2);

        const failing = async () => streamed(['{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n']);
        const truncated = async () => streamed(['{"status":"pulling manifest"}\n']);

        await expect(pullOllamaModel(BASE, "nope", () => undefined, undefined, failing as never)).rejects.toThrow("file does not exist");
        await expect(pullOllamaModel(BASE, "x", () => undefined, undefined, truncated as never)).rejects.toThrow("ended before it finished");
    });
});

describe(deleteOllamaModel, () => {
    it("sends DELETE /api/delete and surfaces a 404", async () => {
        expect.assertions(3);

        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

        await deleteOllamaModel(BASE, "llama3.2:3b", fetchImpl as never);

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];

        expect([url, init.method]).toStrictEqual(["http://localhost:11434/api/delete", "DELETE"]);
        expect(JSON.parse(init.body as string)).toStrictEqual({ model: "llama3.2:3b" });
        await expect(deleteOllamaModel(BASE, "x", (async () => Response.json({ error: "model not found" }, { status: 404 })) as never)).rejects.toMatchObject({
            status: 404,
        });
    });
});

describe(detectOllama, () => {
    it("tells Ollama, another server and no server apart", async () => {
        expect.assertions(3);

        await expect(detectOllama(BASE, (async () => Response.json({ version: "0.12.3" })) as never)).resolves.toBe("0.12.3");
        // LM Studio answers unknown routes with an error body.
        await expect(detectOllama(BASE, (async () => Response.json({ error: "Unexpected endpoint" }, { status: 404 })) as never)).resolves.toBeUndefined();
        await expect(
            detectOllama(BASE, (async () => {
                throw new TypeError("Failed to fetch");
            }) as never),
        ).rejects.toBeInstanceOf(TypeError);
    });
});
