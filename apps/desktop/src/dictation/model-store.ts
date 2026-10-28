import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { ModelSpec } from "./catalog.js";

/** A download that delivers nothing for this long is dead. It restarts on every chunk: the model is hundreds of MB, no single deadline fits. */
const STALL_TIMEOUT_MS = 30_000;

const PARTIAL_SUFFIX = ".partial";

export type ModelStatus = { state: "missing" } | { bytes: number; file: string; state: "present"; version: string };

export class ModelError extends Error {
    public readonly code: "checksum" | "download" | "missing" | "size";

    public constructor(code: ModelError["code"], message: string) {
        super(message);
        this.name = "ModelError";
        this.code = code;
    }
}

export interface ModelStoreOptions {
    directory: string;
    /** Injected so a test can serve bytes without a network. Defaults to the global `fetch`. */
    fetch?: typeof fetch;
    stallTimeoutMs?: number;
}

export interface DownloadOptions {
    onProgress?: (received: number, total: number) => void;
}

export interface ModelStore {
    /** Downloads over HTTPS, verifies the size and SHA-256, then moves the file into place. A mismatch leaves nothing. */
    download: (spec: ModelSpec, options?: DownloadOptions) => Promise<string>;
    /** The path of a model whose bytes hash to the pinned checksum; checked once per file state per run. A mismatch deletes the file. */
    ensureVerified: (spec: ModelSpec) => Promise<string>;
    pathOf: (spec: ModelSpec) => string;
    status: (spec: ModelSpec) => Promise<ModelStatus>;
    /** Removes the leftovers of a download that was interrupted (the process died, the machine slept). */
    sweepPartials: () => Promise<void>;
}

const hashFile = async (file: string): Promise<string> => {
    const hash = createHash("sha256");

    for await (const chunk of createReadStream(file)) {
        hash.update(chunk as Buffer);
    }

    return hash.digest("hex");
};

const removeQuietly = async (file: string): Promise<void> => {
    try {
        await unlink(file);
    } catch {
        // Already gone.
    }
};

/**
 * The model folder under app data. Downloads run in the main process (never the dictation window, which has no network),
 * write to a file beside the target and rename it into place, so a model file exists only once its checksum matched.
 */
export const createModelStore = ({ directory, fetch: fetchFunction = fetch, stallTimeoutMs = STALL_TIMEOUT_MS }: ModelStoreOptions): ModelStore => {
    const pathOf = (spec: ModelSpec): string => path.join(directory, spec.file);
    const verified = new Map<string, string>();
    const inFlight = new Map<string, Promise<string>>();

    const fingerprint = async (file: string): Promise<string> => {
        const info = await stat(file);

        return `${info.size}:${info.mtimeMs}`;
    };

    const status = async (spec: ModelSpec): Promise<ModelStatus> => {
        try {
            const info = await stat(pathOf(spec));

            return info.isFile() ? { bytes: info.size, file: spec.file, state: "present", version: spec.version } : { state: "missing" };
        } catch {
            return { state: "missing" };
        }
    };

    const ensureVerified = async (spec: ModelSpec): Promise<string> => {
        const file = pathOf(spec);
        let print: string;

        try {
            print = await fingerprint(file);
        } catch {
            throw new ModelError("missing", `The speech model ${spec.id} is not downloaded`);
        }

        if (verified.get(file) === print) {
            return file;
        }

        const { size } = await stat(file);

        if (size !== spec.bytes || await hashFile(file) !== spec.sha256) {
            await removeQuietly(file);
            verified.delete(file);

            throw new ModelError("checksum", `The speech model ${spec.id} on disk does not match its checksum and was removed`);
        }

        verified.set(file, print);

        return file;
    };

    const fetchToPartial = async (spec: ModelSpec, partial: string, options: DownloadOptions): Promise<void> => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = (): void => {
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(new Error("stalled")), stallTimeoutMs);
        };

        arm();

        const handle = await open(partial, "wx", 0o600);

        try {
            const response = await fetchFunction(spec.url, { redirect: "follow", signal: controller.signal });

            if (!response.ok || response.body === null) {
                await response.body?.cancel();

                throw new ModelError("download", `The model server answered ${response.status}`);
            }

            const hash = createHash("sha256");
            let received = 0;

            for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                arm();
                received += chunk.byteLength;

                // The pinned size is an upper bound: a server that keeps sending is not the model.
                if (received > spec.bytes) {
                    throw new ModelError("size", "The model download is larger than expected");
                }

                hash.update(chunk);
                await handle.write(chunk);
                options.onProgress?.(received, spec.bytes);
            }

            if (received !== spec.bytes) {
                throw new ModelError("size", `The model download is ${received} bytes, expected ${spec.bytes}`);
            }

            if (hash.digest("hex") !== spec.sha256) {
                throw new ModelError("checksum", "The downloaded speech model does not match its checksum");
            }
        } catch (error) {
            if (controller.signal.aborted) {
                throw new ModelError("download", "The model download stalled");
            }

            throw error;
        } finally {
            clearTimeout(timer);
            await handle.close();
        }
    };

    const downloadOnce = async (spec: ModelSpec, options: DownloadOptions): Promise<string> => {
        const target = pathOf(spec);

        await mkdir(directory, { mode: 0o700, recursive: true });

        // Beside the target, so the rename stays on one volume and is atomic.
        const partial = path.join(directory, `.${spec.file}.${randomBytes(6).toString("hex")}${PARTIAL_SUFFIX}`);

        try {
            await fetchToPartial(spec, partial, options);
            await rename(partial, target);
        } catch (error) {
            await removeQuietly(partial);

            throw error;
        }

        return target;
    };

    const download = (spec: ModelSpec, options: DownloadOptions = {}): Promise<string> => {
        const running = inFlight.get(spec.id);

        if (running !== undefined) {
            return running;
        }

        const started = (async () => {
            try {
                return await downloadOnce(spec, options);
            } finally {
                inFlight.delete(spec.id);
            }
        })();

        inFlight.set(spec.id, started);

        return started;
    };

    const sweepPartials = async (): Promise<void> => {
        let names: string[];

        try {
            names = await readdir(directory);
        } catch {
            return;
        }

        await Promise.all(names.filter((name) => name.endsWith(PARTIAL_SUFFIX)).map((name) => removeQuietly(path.join(directory, name))));
    };

    return { download, ensureVerified, pathOf, status, sweepPartials };
};
