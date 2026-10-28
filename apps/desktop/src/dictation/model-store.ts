import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { ModelSpec } from "./catalog.js";

/** A download that delivers nothing for this long is dead. It restarts on every chunk: the model is hundreds of MB, no single deadline fits. */
const STALL_TIMEOUT_MS = 30_000;

const PARTIAL_SUFFIX = ".partial";

const MAX_REDIRECTS = 5;

/** Hosts the model's own file server may hand a download to, besides the host it was pinned on. */
const FILE_HOST_SUFFIXES = [".huggingface.co", ".hf.co"] as const;

/** A redirect target is HTTPS and on the pinned host or one of its file hosts. */
const isAllowedRedirect = (target: string, pinnedHost: string): boolean => {
    try {
        const { hostname, protocol } = new URL(target);

        return protocol === "https:" && (hostname === pinnedHost || hostname === "huggingface.co" || hostname === "hf.co" || FILE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)));
    } catch {
        return false;
    }
};

export class ModelError extends Error {
    public readonly code: "checksum" | "download" | "missing" | "size";

    public constructor(code: ModelError["code"], message: string) {
        super(message);
        this.name = "ModelError";
        this.code = code;
    }
}

/** `FileHandle.write` may write less than it was given: keep going until the whole chunk is on disk. */
const writeFully = async (handle: FileHandle, chunk: Uint8Array): Promise<void> => {
    let offset = 0;

    while (offset < chunk.byteLength) {
        // eslint-disable-next-line no-await-in-loop -- the next write starts where this one ended
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);

        if (bytesWritten === 0) {
            throw new ModelError("download", "The model file could not be written");
        }

        offset += bytesWritten;
    }
};

export type ModelStatus = { state: "missing" } | { bytes: number; file: string; state: "present"; version: string };

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
    /** Whether a download of this model is running now. */
    isDownloading: (spec: ModelSpec) => boolean;
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
    // Partial files a download is writing now: a sweep that starts late must not unlink one.
    const activePartials = new Set<string>();

    const fingerprint = async (file: string): Promise<string> => {
        const info = await stat(file);

        // ctime moves on every write and cannot be set back, unlike mtime; ino catches a file renamed over the model.
        return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
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

    // The pinned URL may redirect to the file host; any other host, or a plain-http hop, ends the download before
    // the next request is sent, so a compromised or misconfigured upstream cannot point this machine at an internal one.
    const fetchFollowingSafeRedirects = async (start: string, signal: AbortSignal): Promise<Response> => {
        const pinnedHost = new URL(start).hostname;
        let url = start;

        for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
            if (hops > 0 && !isAllowedRedirect(url, pinnedHost)) {
                throw new ModelError("download", "The model server redirected to a host that is not allowed");
            }

            // eslint-disable-next-line no-await-in-loop -- each hop depends on the previous answer
            const response = await fetchFunction(url, { redirect: "manual", signal });

            if (response.status < 300 || response.status >= 400) {
                return response;
            }

            const location = response.headers.get("location");

            // eslint-disable-next-line no-await-in-loop -- the redirect body is dropped before the next hop
            await response.body?.cancel();

            if (location === null) {
                throw new ModelError("download", "The model server sent a redirect with no location");
            }

            url = new URL(location, url).href;
        }

        throw new ModelError("download", "The model server redirected too many times");
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
            const response = await fetchFollowingSafeRedirects(spec.url, controller.signal);

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
                await writeFully(handle, chunk);
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

        activePartials.add(path.basename(partial));

        try {
            await fetchToPartial(spec, partial, options);
            await rename(partial, target);
        } catch (error) {
            await removeQuietly(partial);

            throw error;
        } finally {
            activePartials.delete(path.basename(partial));
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

        await Promise.all(names.filter((name) => name.endsWith(PARTIAL_SUFFIX) && !activePartials.has(name)).map((name) => removeQuietly(path.join(directory, name))));
    };

    return { download, ensureVerified, isDownloading: (spec) => inFlight.has(spec.id), pathOf, status, sweepPartials };
};
