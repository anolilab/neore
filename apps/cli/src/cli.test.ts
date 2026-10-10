import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCommand, UsageError } from "./args";
import { run } from "./cli";
import type { StreamEvent } from "./client";
import { ApiError, errorFromResponse, EXIT, exitCodeFor, NeoreClient, parseNdjson, retryDelayMs } from "./client";
import type { Context } from "./commands";
import { configDirectory, insecurePermissions, readConfig, resolveCredentials, writeConfig } from "./config";
import { formatTable, renderStream, shouldUseColor } from "./render";

const sink = (isTTY = false) => {
    const chunks: string[] = [];

    return {
        isTTY,
        text: () => chunks.join(""),
        write: (chunk: string) => {
            chunks.push(chunk);
        },
    };
};

const ioFor = () => {
    const stdout = sink();
    const stderr = sink();

    return { env: { NO_COLOR: "1" } as NodeJS.ProcessEnv, stderr, stdout };
};

async function* events(...list: StreamEvent[]): AsyncGenerator<StreamEvent> {
    yield* list;
}

const ndjsonBody = (lines: ReadonlyArray<string>, chunkSize = 7): ReadableStream<Uint8Array> => {
    const bytes = new TextEncoder().encode(lines.join(""));

    return new ReadableStream({
        start(controller) {
            for (let index = 0; index < bytes.length; index += chunkSize) {
                controller.enqueue(bytes.slice(index, index + chunkSize));
            }

            controller.close();
        },
    });
};

describe("argument parsing", () => {
    it("resolves grouped commands, flags and positionals", () => {
        expect(parseCommand(["threads", "rm", "abc", "--yes", "--json"])).toEqual({ args: ["abc"], command: "threads rm", flags: { json: true, yes: true } });
        expect(parseCommand(["chat", "hello", "world", "-m", "gpt", "--no-stream"])).toEqual({
            args: ["hello", "world"],
            command: "chat",
            flags: { model: "gpt", "no-stream": true },
        });
        expect(parseCommand(["threads"]).command).toBe("threads ls");
        expect(parseCommand([]).command).toBe("help");
    });

    it("rejects unknown commands, subcommands and flags as usage errors", () => {
        expect(() => parseCommand(["thread", "ls"])).toThrow(UsageError);
        expect(() => parseCommand(["threads", "delete"])).toThrow("threads rm");
        expect(() => parseCommand(["chat", "--no-strem"])).toThrow(UsageError);
    });

    it("exits 2 on a usage error and 0 on --version", async () => {
        const io = ioFor();
        const context = { io } as unknown as Context;

        expect(await run(["bogus"], context)).toBe(EXIT.usage);
        expect(io.stderr.text()).toContain('Unknown command "bogus"');
        expect(await run(["--version"], context)).toBe(EXIT.ok);
    });
});

describe("config file", () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "neore-cli-"));
    });

    afterEach(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    it.skipIf(process.platform === "win32")("is written 0600 in a 0700 directory, even over a looser existing file", async () => {
        const path = join(directory, "nested", "config.json");

        const modeOf = async (target: string): Promise<number> => {
            const stats = await stat(target);

            return stats.mode & 0o777;
        };

        await writeConfig({ apiKey: "nk_1", apiUrl: "https://x" }, path);
        expect(await modeOf(path)).toBe(0o600);
        expect(await modeOf(join(directory, "nested"))).toBe(0o700);

        await writeFile(path, "{}");
        await chmod(path, 0o644);
        expect(await insecurePermissions(path)).toBe("0644");

        await writeConfig({ apiKey: "nk_2" }, path);
        expect(await modeOf(path)).toBe(0o600);
        expect(await insecurePermissions(path)).toBeNull();
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ apiKey: "nk_2" });
    });

    it("reads a missing file as empty and ignores foreign fields", async () => {
        expect(await readConfig(join(directory, "none.json"))).toEqual({});
        await writeFile(join(directory, "c.json"), JSON.stringify({ apiKey: 5, apiUrl: "https://x", other: true }));
        expect(await readConfig(join(directory, "c.json"))).toEqual({ apiUrl: "https://x" });
    });

    it("lets the environment override the file", () => {
        expect(resolveCredentials({ apiKey: "file", apiUrl: "https://file" }, { NEORE_API_KEY: "env" })).toEqual({ apiKey: "env", apiUrl: "https://file" });
    });

    it("follows platform conventions for the directory", () => {
        expect(configDirectory({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/u")).toBe("/xdg/neore");
        expect(configDirectory({}, "linux", "/home/u")).toBe("/home/u/.config/neore");
        expect(configDirectory({}, "darwin", "/Users/u")).toBe("/Users/u/Library/Application Support/neore");
        expect(configDirectory({ APPDATA: String.raw`C:\Users\u\AppData\Roaming` }, "win32", String.raw`C:\Users\u`)).toBe(
            String.raw`C:\Users\u\AppData\Roaming\neore`,
        );
        expect(configDirectory({}, "win32", String.raw`C:\Users\u`)).toBe(String.raw`C:\Users\u\AppData\Roaming\neore`);
    });
});

describe("stream renderer", () => {
    it("writes text to stdout, reasoning to stderr only when asked, and returns the reply", async () => {
        const io = ioFor();
        const result = await renderStream(
            events({ text: "think", type: "reasoning" }, { text: "Hel", type: "text" }, { text: "lo", type: "text" }, { status: "done", type: "done" }),
            io,
            { showReasoning: true },
        );

        expect(io.stdout.text()).toBe("Hello\n");
        expect(io.stderr.text()).toBe("think\n");
        expect(result).toEqual({ reasoning: "think", status: "done", text: "Hello" });
    });

    it("keeps partial text and throws on an error event", async () => {
        const io = ioFor();

        await expect(
            renderStream(events({ text: "par", type: "text" }, { error: { code: "generation_failed", message: "boom" }, type: "error" }), io),
        ).rejects.toMatchObject({
            code: "generation_failed",
        });
        expect(io.stdout.text()).toBe("par\n");
    });

    it("treats a stream without a terminal event as interrupted", async () => {
        await expect(renderStream(events({ text: "x", type: "text" }), ioFor())).rejects.toMatchObject({ code: "stream_interrupted" });
    });

    it("emits NDJSON in json mode", async () => {
        const io = ioFor();

        await renderStream(events({ text: "a", type: "text" }, { status: "done", type: "done" }), io, { json: true });
        expect(
            io.stdout
                .text()
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as StreamEvent),
        ).toEqual([
            { text: "a", type: "text" },
            { status: "done", type: "done" },
        ]);
    });

    it("parses NDJSON split at arbitrary byte boundaries, multibyte characters included", async () => {
        const parsed: StreamEvent[] = await Array.fromAsync(
            parseNdjson(ndjsonBody(['{"type":"text","text":"héllo 👋"}\n', '{"type":"done","status":"done"}'], 3)),
        );

        expect(parsed).toEqual([
            { text: "héllo 👋", type: "text" },
            { status: "done", type: "done" },
        ]);
    });

    it("disables colour for NO_COLOR and pipes", () => {
        expect(shouldUseColor({ isTTY: true, write: () => {} }, { NO_COLOR: "1" })).toBe(false);
        expect(shouldUseColor({ isTTY: false, write: () => {} }, {})).toBe(false);
        expect(shouldUseColor({ isTTY: false, write: () => {} }, { FORCE_COLOR: "1" })).toBe(true);
    });

    it("formats aligned tables", () => {
        expect(
            formatTable([
                ["ID", "TITLE"],
                ["abc", "multi\nline"],
            ]),
        ).toBe("ID   TITLE\nabc  multi line\n");
    });
});

describe("API client error mapping", () => {
    it("reads the API's error shape", async () => {
        const error = await errorFromResponse(
            Response.json({ error: { code: "insufficient_scope", details: { required: ["chat:write"] }, message: "no", requestId: "r1" } }, { status: 403 }),
        );

        expect(error).toMatchObject({ code: "insufficient_scope", requestId: "r1", status: 403 });
        expect(exitCodeFor(error)).toBe(EXIT.auth);
    });

    it("tolerates a non-API body", async () => {
        const error = await errorFromResponse(new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));

        expect(error.code).toBe("service_unavailable");
        expect(exitCodeFor(error)).toBe(EXIT.network);
    });

    it("maps codes to exit codes", () => {
        const make = (code: string) => new ApiError({ code, message: "", status: 0 });

        expect(exitCodeFor(make("not_found"))).toBe(EXIT.notFound);
        expect(exitCodeFor(make("daily_limit_reached"))).toBe(EXIT.rateLimited);
        expect(exitCodeFor(new Error("x"))).toBe(EXIT.error);
    });

    it("retries transport failures with the same idempotency key", async () => {
        const keys: (string | null)[] = [];
        let calls = 0;
        const client = new NeoreClient({
            apiKey: "nk_1",
            baseUrl: "https://api.test/",
            fetch: (async (_url: string, init: RequestInit) => {
                calls += 1;
                keys.push(new Headers(init.headers).get("Idempotency-Key"));

                if (calls === 1) {
                    throw new TypeError("fetch failed");
                }

                return Response.json({ id: "t1" }, { status: 201 });
            }) as unknown as typeof fetch,
            sleep: async () => {},
        });

        expect(await client.request("POST", "/tasks", { body: {} })).toEqual({ id: "t1" });
        expect(calls).toBe(2);
        expect(keys[0]).toBeTruthy();
        expect(keys[1]).toBe(keys[0]);
    });

    it("does not retry client errors, and waits out short rate limits only", () => {
        expect(retryDelayMs(new ApiError({ code: "invalid_request", message: "", status: 400 }), 0)).toBeUndefined();
        expect(retryDelayMs(new ApiError({ code: "rate_limited", details: { retryAfterSeconds: 2 }, message: "", status: 429 }), 0)).toBe(2000);
        expect(retryDelayMs(new ApiError({ code: "rate_limited", details: { retryAfterSeconds: 60 }, message: "", status: 429 }), 0)).toBeUndefined();
    });
});

describe("chat end to end against a fake API", () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "neore-cli-"));
    });

    afterEach(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    const contextWith = (fetchImpl: typeof fetch): Context & { io: ReturnType<typeof ioFor> } => {
        return {
            configFile: join(directory, "config.json"),
            fetch: fetchImpl,
            io: ioFor(),
            readFile: async () => new Uint8Array(),
            readLine: async () => null,
            readStdin: async () => null,
            stdinIsTTY: true,
        };
    };

    it("starts a chat, streams the reply and prints the thread id", async () => {
        await writeConfig({ apiKey: "nk_1", apiUrl: "https://api.test" }, join(directory, "config.json"));

        const seen: string[] = [];
        const context = contextWith((async (url: string, init: RequestInit) => {
            seen.push(`${init.method} ${new URL(url).pathname} ${new Headers(init.headers).get("Authorization")}`);

            if (url.endsWith("/api/v1/chat")) {
                return Response.json({ messageId: "m1", streamId: "s1", streamToken: "tok", threadId: "th1" }, { status: 202 });
            }

            return new Response(ndjsonBody(['{"type":"text","text":"Hi there"}\n', '{"type":"done","status":"done"}\n']), {
                headers: { "Content-Type": "application/x-ndjson" },
            });
        }) as unknown as typeof fetch);

        expect(await run(["chat", "hello"], context)).toBe(EXIT.ok);
        expect(context.io.stdout.text()).toBe("Hi there\n");
        expect(context.io.stderr.text()).toContain("thread th1");
        expect(seen).toEqual(["POST /api/v1/chat Bearer nk_1", "POST /api/v1/chat/stream Bearer nk_1"]);
    });

    it("follows resume events across requests without showing them", async () => {
        await writeConfig({ apiKey: "nk_1", apiUrl: "https://api.test" }, join(directory, "config.json"));

        const streamBodies: unknown[] = [];
        const context = contextWith((async (url: string, init: RequestInit) => {
            if (url.endsWith("/api/v1/chat")) {
                return Response.json({ messageId: "m1", streamId: "s1", streamToken: "tok", threadId: "th1" }, { status: 202 });
            }

            const body = JSON.parse(String(init.body)) as { lastChunkIndex?: number };

            streamBodies.push(body);

            // One relay per request: each of the first two ends with a resume marker.
            const relays: Record<number, string[]> = {
                0: ['{"type":"text","text":"Hi "}\n', '{"type":"resume","lastChunkIndex":1}\n'],
                1: ['{"type":"text","text":"there"}\n', '{"type":"resume","lastChunkIndex":2}\n'],
                2: ['{"type":"text","text":"!"}\n', '{"type":"done","status":"done"}\n'],
            };
            const lines = relays[body.lastChunkIndex ?? 0]!;

            return new Response(ndjsonBody(lines), { headers: { "Content-Type": "application/x-ndjson" } });
        }) as unknown as typeof fetch);

        expect(await run(["chat", "hello"], context)).toBe(EXIT.ok);
        expect(context.io.stdout.text()).toBe("Hi there!\n");
        expect(streamBodies).toEqual([
            { resumable: true, streamToken: "tok" },
            { lastChunkIndex: 1, resumable: true, streamToken: "tok" },
            { lastChunkIndex: 2, resumable: true, streamToken: "tok" },
        ]);
    });

    it("kb upload sends the file over TUS with the key in a header, then registers the upload id", async () => {
        await writeConfig({ apiKey: "nk_1", apiUrl: "https://api.test" }, join(directory, "config.json"));

        const seen: string[] = [];
        const context = {
            ...contextWith((async (url: string, init: RequestInit) => {
                const headers = new Headers(init.headers);

                seen.push(`${String(init.method)} ${new URL(url).pathname} ${String(headers.get("Authorization"))} ${String(headers.get("Upload-Offset"))}`);

                if (init.method === "POST" && url.endsWith("/api/v1/uploads")) {
                    expect(headers.get("Upload-Length")).toBe("8");
                    expect(headers.get("Upload-Metadata")).toBe(`filename ${btoa("notes.pdf")},mimeType ${btoa("application/pdf")}`);

                    return new Response(null, { headers: { Location: "https://api.test/api/v1/uploads/upload-1" }, status: 201 });
                }

                if (init.method === "PATCH") {
                    return new Response(null, { headers: { "Upload-Offset": "8" }, status: 204 });
                }

                expect(JSON.parse(String(init.body))).toEqual({ name: "notes.pdf", uploadId: "upload-1" });

                return Response.json({ id: "kf1", status: "pending" }, { status: 201 });
            }) as unknown as typeof fetch),
            readFile: async () => new TextEncoder().encode("%PDF-1.7"),
        };

        expect(await run(["kb", "upload", "notes.pdf"], context)).toBe(EXIT.ok);
        expect(seen).toEqual([
            "POST /api/v1/uploads Bearer nk_1 null",
            "PATCH /api/v1/uploads/upload-1 Bearer nk_1 0",
            "POST /api/v1/knowledge/files Bearer nk_1 null",
        ]);
        expect(context.io.stdout.text()).toContain("kf1");
    });

    it("exits 3 with a hint when the key lacks a scope", async () => {
        await writeConfig({ apiKey: "nk_1", apiUrl: "https://api.test" }, join(directory, "config.json"));

        const context = contextWith((async () =>
            Response.json(
                { error: { code: "insufficient_scope", details: { required: ["threads:write"] }, message: "missing" } },
                { status: 403 },
            )) as unknown as typeof fetch);

        expect(await run(["threads", "rm", "t1", "--yes"], context)).toBe(EXIT.auth);
        expect(context.io.stderr.text()).toContain("threads:write");
    });

    it("refuses an unconfirmed delete when not interactive", async () => {
        const context = { ...contextWith(fetch), stdinIsTTY: false };

        expect(await run(["threads", "rm", "t1"], context)).toBe(EXIT.usage);
    });

    it("login verifies the key before saving it", async () => {
        const context = contextWith((async () =>
            Response.json({ error: { code: "invalid_api_key", message: "bad" } }, { status: 401 })) as unknown as typeof fetch);

        expect(await run(["login", "--api-url", "https://api.test", "--key", "nk_bad"], context)).toBe(EXIT.auth);
        expect(await readConfig(join(directory, "config.json"))).toEqual({});
    });
});
