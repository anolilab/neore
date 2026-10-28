import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelSpec } from "./catalog.js";
import { LARGE_V3_TURBO_Q5, modelFor, SMALL } from "./catalog.js";
import { createModelStore, ModelError } from "./model-store.js";

const PAYLOAD = Buffer.from("a stand-in for model weights, long enough to arrive in three chunks".repeat(3));
const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const spec: ModelSpec = {
    bytes: PAYLOAD.length,
    file: "ggml-test.bin",
    id: "test",
    label: "Test",
    sha256: sha(PAYLOAD),
    url: "https://models.example/ggml-test.bin",
    version: "rev1",
};

/** A response whose body arrives in `chunks`, then hangs if `stall` is set until `signal` aborts, as a real fetch body does. */
const responseOf = (chunks: Buffer[], options: { signal?: AbortSignal; stall?: boolean; status?: number } = {}): Response => {
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
            if (index < chunks.length) {
                controller.enqueue(chunks[index]);
                index += 1;

                return;
            }

            if (options.stall) {
                await new Promise((_resolve, reject) => {
                    options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
                });
            }

            controller.close();
        },
    });

    return new Response(body, { status: options.status ?? 200 });
};

const split = (bytes: Buffer): Buffer[] => [bytes.subarray(0, 40), bytes.subarray(40, 90), bytes.subarray(90)];

let directory: string;

beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "neore-models-"));
});

afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
});

describe("catalog", () => {
    it("pins both models by an exact revision, size and checksum", () => {
        for (const model of [LARGE_V3_TURBO_Q5, SMALL]) {
            expect(model.url).toContain(`/resolve/${model.version}/`);
            expect(model.version).toMatch(HEX_40);
            expect(model.sha256).toMatch(HEX_64);
            expect(new URL(model.url).protocol).toBe("https:");
        }
    });

    it("gives Apple Silicon the large model and every other machine the small one", () => {
        expect(modelFor("darwin", "arm64")).toBe(LARGE_V3_TURBO_Q5);
        expect(modelFor("darwin", "x64")).toBe(SMALL);
        expect(modelFor("win32", "x64")).toBe(SMALL);
        expect(modelFor("linux", "arm64")).toBe(SMALL);
    });
});

describe("download", () => {
    it("moves a verified model into place and reports progress", async () => {
        const progress: number[] = [];
        const store = createModelStore({ directory, fetch: async () => responseOf(split(PAYLOAD)) });
        const file = await store.download(spec, {
            onProgress: (received) => {
                progress.push(received);
            },
        });

        expect(file).toBe(path.join(directory, spec.file));
        expect(await readFile(file)).toStrictEqual(PAYLOAD);
        expect(progress.at(-1)).toBe(PAYLOAD.length);
        expect(await store.status(spec)).toStrictEqual({ bytes: PAYLOAD.length, file: spec.file, state: "present", version: "rev1" });
        // Only the model: the partial file is gone.
        expect(await readdir(directory)).toStrictEqual([spec.file]);
    });

    it("leaves no file when the checksum does not match", async () => {
        const tampered = Buffer.from(PAYLOAD);

        tampered[3] = tampered[3] === 0 ? 1 : 0;

        const store = createModelStore({ directory, fetch: async () => responseOf(split(tampered)) });

        await expect(store.download(spec)).rejects.toMatchObject({ code: "checksum" });
        expect(await readdir(directory)).toStrictEqual([]);
        expect(await store.status(spec)).toStrictEqual({ state: "missing" });
    });

    it("leaves a model that was already there when a re-download fails", async () => {
        await writeFile(path.join(directory, spec.file), PAYLOAD);

        const store = createModelStore({ directory, fetch: async () => responseOf(split(PAYLOAD.subarray(0, 60))) });

        await expect(store.download(spec)).rejects.toMatchObject({ code: "size" });
        expect(await readdir(directory)).toStrictEqual([spec.file]);
    });

    it("aborts a stream that passes the pinned size", async () => {
        const store = createModelStore({ directory, fetch: async () => responseOf([...split(PAYLOAD), Buffer.from("more")]) });

        await expect(store.download(spec)).rejects.toMatchObject({ code: "size" });
        expect(await readdir(directory)).toStrictEqual([]);
    });

    it("refuses a short body", async () => {
        const store = createModelStore({ directory, fetch: async () => responseOf([PAYLOAD.subarray(0, 10)]) });

        await expect(store.download(spec)).rejects.toMatchObject({ code: "size" });
        expect(await readdir(directory)).toStrictEqual([]);
    });

    it("fails on an error status without writing anything", async () => {
        const store = createModelStore({ directory, fetch: async () => responseOf([], { status: 503 }) });

        await expect(store.download(spec)).rejects.toMatchObject({ code: "download" });
        expect(await readdir(directory)).toStrictEqual([]);
    });

    it("gives up on a stalled stream by a deadline that restarts with every chunk", async () => {
        const seen: AbortSignal[] = [];
        const store = createModelStore({
            directory,
            fetch: async (_url, init) => {
                const signal = init?.signal as AbortSignal;

                seen.push(signal);

                return responseOf([PAYLOAD.subarray(0, 30)], { signal, stall: true });
            },
            stallTimeoutMs: 40,
        });

        await expect(store.download(spec)).rejects.toMatchObject({ code: "download", message: "The model download stalled" });
        expect(seen[0]?.aborted).toBe(true);
        expect(await readdir(directory)).toStrictEqual([]);
    });

    it("shares one download between two callers", async () => {
        let calls = 0;
        const store = createModelStore({
            directory,
            fetch: async () => {
                calls += 1;

                return responseOf(split(PAYLOAD));
            },
        });

        await Promise.all([store.download(spec), store.download(spec)]);
        expect(calls).toBe(1);
    });

    it("sweeps the partial file an interrupted download left behind", async () => {
        await writeFile(path.join(directory, ".ggml-test.bin.abc.partial"), "half");
        await writeFile(path.join(directory, spec.file), PAYLOAD);

        await createModelStore({ directory }).sweepPartials();

        expect(await readdir(directory)).toStrictEqual([spec.file]);
    });
});

describe("ensureVerified", () => {
    it("returns the path of a model whose bytes match", async () => {
        await writeFile(path.join(directory, spec.file), PAYLOAD);

        expect(await createModelStore({ directory }).ensureVerified(spec)).toBe(path.join(directory, spec.file));
    });

    it("deletes a model that does not match and says so", async () => {
        await writeFile(path.join(directory, spec.file), Buffer.concat([PAYLOAD.subarray(0, -1), Buffer.from("!")]));

        const store = createModelStore({ directory });

        await expect(store.ensureVerified(spec)).rejects.toMatchObject({ code: "checksum" });
        await expect(stat(path.join(directory, spec.file))).rejects.toThrow();
    });

    it("deletes a model of the wrong size", async () => {
        await writeFile(path.join(directory, spec.file), PAYLOAD.subarray(0, 5));

        await expect(createModelStore({ directory }).ensureVerified(spec)).rejects.toBeInstanceOf(ModelError);
        expect(await readdir(directory)).toStrictEqual([]);
    });

    it("reports a missing model", async () => {
        await expect(createModelStore({ directory }).ensureVerified(spec)).rejects.toMatchObject({ code: "missing" });
    });

    it("re-checks a file that changed after it was verified", async () => {
        const file = path.join(directory, spec.file);
        const store = createModelStore({ directory });

        await writeFile(file, PAYLOAD);
        await store.ensureVerified(spec);

        const swapped = Buffer.from(PAYLOAD);

        swapped[0] = swapped[0] === 0 ? 1 : 0;
        await writeFile(file, swapped);
        await utimes(file, new Date(), new Date(Date.now() + 5000));

        await expect(store.ensureVerified(spec)).rejects.toMatchObject({ code: "checksum" });
    });
});
