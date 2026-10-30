import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelSpec } from "./catalog.js";
import { LARGE_V3_TURBO_Q5, offeredModels, resolveModel, SMALL } from "./catalog.js";
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

    it("defaults Apple Silicon to the large model and every other machine to the small one", () => {
        expect(resolveModel(undefined, "darwin", "arm64")).toBe(LARGE_V3_TURBO_Q5);
        expect(resolveModel(undefined, "darwin", "x64")).toBe(SMALL);
        expect(resolveModel(undefined, "win32", "x64")).toBe(SMALL);
        expect(resolveModel(undefined, "linux", "arm64")).toBe(SMALL);
    });

    it("offers both models everywhere, with exactly one default, and says the small one is weaker on Chinese and Italian", () => {
        for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"], ["linux", "arm64"]] as const) {
            const offered = offeredModels(platform, arch);

            expect(new Set(offered.map((model) => model.spec.id))).toStrictEqual(new Set(["large-v3-turbo-q5_0", "small"]));
            expect(offered.filter(({ isDefault }) => isDefault)).toHaveLength(1);
            expect(offered.find((model) => model.spec === SMALL)?.note).toContain("Chinese and Italian");
        }
    });

    it("uses the chosen model when it is offered and falls back to the default for anything else", () => {
        expect(resolveModel("small", "darwin", "arm64")).toBe(SMALL);
        expect(resolveModel("large-v3-turbo-q5_0", "linux", "x64")).toBe(LARGE_V3_TURBO_Q5);
        expect(resolveModel("../../etc/passwd", "linux", "x64")).toBe(SMALL);
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

    it("reports a download while it runs and not after", async () => {
        const store = createModelStore({ directory, fetch: async () => responseOf(split(PAYLOAD)) });

        expect(store.isDownloading(spec)).toBe(false);

        const running = store.download(spec);

        expect(store.isDownloading(spec)).toBe(true);

        await running;

        expect(store.isDownloading(spec)).toBe(false);
    });

    it("sweeps the partial file an interrupted download left behind", async () => {
        await writeFile(path.join(directory, ".ggml-test.bin.abc.partial"), "half");
        await writeFile(path.join(directory, spec.file), PAYLOAD);

        await createModelStore({ directory }).sweepPartials();

        expect(await readdir(directory)).toStrictEqual([spec.file]);
    });
});

describe("download redirects", () => {
    const redirectTo = (location: string): Response => new Response(null, { headers: { location }, status: 302 });

    it("follows a redirect to the model's file host and leaves a model on disk", async () => {
        const seen: string[] = [];
        const store = createModelStore({
            directory,
            fetch: (async (url: string) => {
                seen.push(url);

                return seen.length === 1 ? redirectTo("https://cdn-lfs.huggingface.co/file") : responseOf(split(PAYLOAD));
            }) as unknown as typeof fetch,
        });

        await store.download(spec);

        expect(seen).toEqual(["https://models.example/ggml-test.bin", "https://cdn-lfs.huggingface.co/file"]);
    });

    it("stops before asking a host that is not the model's, or one over plain http", async () => {
        for (const location of ["https://169.254.169.254/latest", ["http", "://models.example/file"].join(""), "https://models.example.evil.test/file"]) {
            const asked: string[] = [];
            const store = createModelStore({
                directory,
                fetch: (async (url: string) => {
                    asked.push(url);

                    return redirectTo(location);
                }) as unknown as typeof fetch,
            });

            await expect(store.download(spec)).rejects.toMatchObject({ code: "download" });
            // Every attempt (the store retries) asked only the pinned URL, never the redirect target.
            expect([...new Set(asked)]).toEqual([spec.url]);
            expect(await readdir(directory)).toEqual([]);
        }
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

    it("re-checks a same-size replacement whose modification time was put back", async () => {
        const file = path.join(directory, spec.file);
        const store = createModelStore({ directory });

        // Whole seconds, so putting the time back reproduces it exactly.
        const pinned = 1_700_000_000;

        await writeFile(file, PAYLOAD);
        await utimes(file, pinned, pinned);
        await store.ensureVerified(spec);

        const swapped = Buffer.from(PAYLOAD);

        swapped[0] = swapped[0] === 0 ? 1 : 0;
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });
        await writeFile(file, swapped);
        await utimes(file, pinned, pinned);

        await expect(store.ensureVerified(spec)).rejects.toMatchObject({ code: "checksum" });
    });
});

describe("remove", () => {
    it("deletes the model file and nothing else", async () => {
        await writeFile(path.join(directory, spec.file), PAYLOAD);
        await writeFile(path.join(directory, "ggml-other.bin"), "other");

        const store = createModelStore({ directory });

        await store.remove(spec);

        expect(await readdir(directory)).toStrictEqual(["ggml-other.bin"]);
        expect(await store.status(spec)).toStrictEqual({ state: "missing" });
    });

    it("succeeds when there is no file, and forgets that a file was verified", async () => {
        const store = createModelStore({ directory });

        await writeFile(path.join(directory, spec.file), PAYLOAD);
        await store.ensureVerified(spec);
        await store.remove(spec);
        await store.remove(spec);

        await expect(store.ensureVerified(spec)).rejects.toMatchObject({ code: "missing" });
    });

    it("stops a download of that model and leaves no file behind", async () => {
        const store = createModelStore({
            directory,
            fetch: async (_url, init) => responseOf([PAYLOAD.subarray(0, 30)], { signal: init?.signal as AbortSignal, stall: true }),
        });
        const running = store.download(spec);
        const rejection = expect(running).rejects.toMatchObject({ code: "cancelled" });

        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });
        await store.remove(spec);
        await rejection;
        expect(store.isDownloading(spec)).toBe(false);
        expect(await readdir(directory)).toStrictEqual([]);
    });
});

describe("remove, when the file cannot be deleted", () => {
    it("fails instead of reporting a deletion, and leaves the file", async () => {
        // A directory where the file should be: the unlink fails with something other than "not found".
        await mkdir(path.join(directory, spec.file));

        await expect(createModelStore({ directory }).remove(spec)).rejects.toMatchObject({ code: "delete" });
        expect(await readdir(directory)).toStrictEqual([spec.file]);
    });
});

describe("a download cancelled after its last byte", () => {
    it("does not move the model into place and leaves the folder empty", async () => {
        let cancelling: Promise<void> | undefined;
        const store = createModelStore({ directory, fetch: async () => responseOf(split(PAYLOAD)) });
        const running = store.download(spec, {
            onProgress: (received) => {
                // The bytes are all in and verified a moment later: the switch goes off right now.
                if (received === PAYLOAD.length) {
                    cancelling = store.cancelDownloads();
                }
            },
        });

        await expect(running).rejects.toMatchObject({ code: "cancelled" });
        await cancelling;
        expect(await readdir(directory)).toStrictEqual([]);
        expect(await store.status(spec)).toStrictEqual({ state: "missing" });
    });
});

describe("cancelDownloads", () => {
    it("stops every download and leaves the folder empty", async () => {
        const store = createModelStore({
            directory,
            fetch: async (_url, init) => responseOf([PAYLOAD.subarray(0, 30)], { signal: init?.signal as AbortSignal, stall: true }),
        });
        const running = store.download(spec);
        const rejection = expect(running).rejects.toMatchObject({ code: "cancelled" });

        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });
        await store.cancelDownloads();
        await rejection;
        expect(await readdir(directory)).toStrictEqual([]);
    });

    it("does nothing when nothing is downloading", async () => {
        await expect(createModelStore({ directory }).cancelDownloads()).resolves.toBeUndefined();
    });
});
