/**
 * Portable workflow files: a `.zip` holding `workflow.json` (the manifest) and every
 * image or document the workflow references, as bytes under `assets/<sha256>.<ext>`.
 *
 * The workflow's stored references are chat file ids, which mean nothing outside the
 * account that uploaded them, and the signed URLs they resolve to expire. So export
 * fetches each file through the owner's grant and rewrites the reference to its asset
 * path; import re-uploads each asset (TUS, then finalize) and points the node at the
 * new id. Inline `data:` images are bundled the same way. External `http(s)` URLs are
 * kept as they are.
 *
 * The archive is untrusted input on import: entry names are matched exactly, never
 * joined onto a path, and every count and size is capped before it is read.
 */
import { chatAttachmentLimit } from "@neore/backend/document-limits";

import type { JsZipLike, JsZipWriter, LoadZip } from "@/lib/zip";

import type { VideoFrameFileIds, WorkflowContent, WorkflowNode } from "../types";
import NODE_CONFIGS from "../types";

export const WORKFLOW_BUNDLE_FORMAT = "neore-workflow";
const WORKFLOW_BUNDLE_VERSION = 1;

const MANIFEST_PATH = "workflow.json";
const ASSET_PATH = /^assets\/[\da-f]{64}\.[a-z\d]{1,5}$/u;
const DATA_URL = /^data:([^;,]+);base64,(.*)$/su;
const WINDOWS_DRIVE = /^[a-z]:/iu;

/** The archive as a whole, read or written. */
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
/** ponytail: the upload rate limit (`chat/attachmentUpload`, 30 burst on free, 90 on premium) bounds a real import; assets past it are reported as skipped. */
const MAX_BUNDLE_ASSETS = 100;

/** `workflow.json`, the folder entries JSZip writes, and up to {@link MAX_BUNDLE_ASSETS} files. */
export const MAX_BUNDLE_ENTRIES = 128;
const MAX_BUNDLE_NODES = 2000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** The inflated bytes all of a bundle's assets may total; the archive is read against this, and export writes within it. */
export const ASSET_BYTE_BUDGET = MAX_BUNDLE_BYTES - MAX_MANIFEST_BYTES;

/**
 * The image and PDF types a bundle carries. A deliberate mirror of the image and PDF entries in
 * `UPLOAD_ALLOWED_MIME` (`backend/lunora/vault/lib/file-constants.ts`); the web app does not import
 * that list, so keep the two in step. Audio and video are not on it, so a workflow referencing them skips them.
 */
const ASSET_TYPE_BY_EXTENSION = new Map<string, string>([
    ["bmp", "image/bmp"],
    ["gif", "image/gif"],
    ["ico", "image/x-icon"],
    ["jpg", "image/jpeg"],
    ["pdf", "application/pdf"],
    ["png", "image/png"],
    ["svg", "image/svg+xml"],
    ["webp", "image/webp"],
]);

const EXTENSION_BY_TYPE = new Map([...ASSET_TYPE_BY_EXTENSION].map(([extension, type]): [string, string] => [type, extension]));

/** Why a file cannot be read; the component words each one (translated). */
export type WorkflowBundleErrorCode =
    | "asset-mismatch"
    | "invalid-node"
    | "not-workflow"
    | "too-large"
    | "too-many-entries"
    | "too-many-nodes"
    | "unknown-node-type"
    | "unknown-version"
    | "unsafe-path";

export class WorkflowBundleError extends Error {
    public readonly code: WorkflowBundleErrorCode;

    public constructor(code: WorkflowBundleErrorCode) {
        super(code);
        this.name = "WorkflowBundleError";
        this.code = code;
    }
}

/** Bytes of one asset, as read from or downloaded for a bundle. */
interface BundleSource {
    bytes: Uint8Array<ArrayBuffer>;
    contentType: string;
}

/** Where an imported asset landed on the server. */
interface StoredAsset {
    fileId: string;
    url: string;
}

interface ReadBundleOptions {
    loadZip: LoadZip;
}

export interface WorkflowBundle {
    /** Whether the manifest is the bundle format (asset paths and raw ids are then exporter-local). */
    bundled: boolean;
    content: WorkflowContent;
    /** Reads one referenced asset; throws when its bytes do not match the name. `undefined` when the archive lacks it. */
    readAsset: (path: string) => Promise<BundleSource | undefined>;
}

type Fields = Record<string, unknown>;

/** One stored file a node points at. Paths are into `node.data`; `frameFileIds` nests them. */
interface AssetReference {
    /** The chat file id. */
    idPath: ReadonlyArray<string>;
    /** An inline image: a `data:` URL is bundled, an external URL is kept. */
    inlinePath?: string;
    /** The signed URL that is set again on import. */
    urlPath?: string;
}

/** A frame file from an earlier build. The kinds are checked against `VideoFrameFileIds`, so a renamed kind fails the build instead of dropping its frame. */
const frameReference = (kind: keyof VideoFrameFileIds): AssetReference => {
    return { idPath: ["frameFileIds", kind] };
};

/** Every node field that holds a stored file. Both directions walk this table; a node carries only the fields it uses. */
const ASSET_REFERENCES: ReadonlyArray<AssetReference> = [
    { idPath: ["imageFileId"], inlinePath: "imageUrl" },
    { idPath: ["fileId"], urlPath: "fileUrl" },
    ...(["start", "end", "picked"] as const satisfies ReadonlyArray<keyof VideoFrameFileIds>).map((kind) => frameReference(kind)),
];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isAssetPath = (value: unknown): value is string => typeof value === "string" && ASSET_PATH.test(value);

/** Entry names that could escape a directory if anything ever joined them onto one. */
const isUnsafeEntryName = (name: string): boolean => name.startsWith("/") || name.includes("\\") || WINDOWS_DRIVE.test(name) || name.split("/").includes("..");

const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const getAt = (fields: Fields, path: ReadonlyArray<string>): unknown => {
    let holder: unknown = fields;

    for (const key of path) {
        holder = isRecord(holder) ? holder[key] : undefined;
    }

    return holder;
};

/** A copy of `fields` with `value` at `path`; `undefined` removes it, and a parent left empty goes with it. Never mutates. */
const setAt = (fields: Fields, path: ReadonlyArray<string>, value: unknown): Fields => {
    const [key, ...rest] = path;

    if (key === undefined || (value === undefined && getAt(fields, path) === undefined)) {
        return fields;
    }

    const next: Fields = { ...fields };

    if (rest.length === 0) {
        if (value === undefined) {
            delete next[key];
        } else {
            next[key] = value;
        }

        return next;
    }

    const child = setAt(isRecord(fields[key]) ? (fields[key] as Fields) : {}, rest, value);

    if (Object.keys(child).length === 0) {
        delete next[key];
    } else {
        next[key] = child;
    }

    return next;
};

/** Runs `run` once per key and shares its promise, so a file many nodes reference is fetched and stored once. */
const memoAsync = <K, V>(run: (key: K) => Promise<V>): ((key: K) => Promise<V>) => {
    const cache = new Map<K, Promise<V>>();

    return (key) => {
        let result = cache.get(key);

        if (!result) {
            result = run(key);
            cache.set(key, result);
        }

        return result;
    };
};

/** The part of a JSZip entry stream this reader uses. JSZip's typings omit `internalStream`, but its `async` is built on it. */
interface InflatingStream {
    on: {
        (event: "data", listener: (chunk: Uint8Array) => void): InflatingStream;
        (event: "end", listener: () => void): InflatingStream;
        (event: "error", listener: (error: Error) => void): InflatingStream;
    };
    pause: () => InflatingStream;
    resume: () => InflatingStream;
}

/**
 * An entry's bytes, read chunk by chunk and stopped once they pass `maxBytes`. `async()` inflates the whole
 * entry before any size check, so a small archive could expand to far more than the cap first.
 */
const readEntryCapped = (entry: JsZipLike["files"][string], maxBytes: number): Promise<Uint8Array<ArrayBuffer>> =>
    new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        let total = 0;
        // The one cast: JSZip inflates through this stream but does not type it.
        const stream = (entry as unknown as { internalStream: (type: "uint8array") => InflatingStream }).internalStream("uint8array");

        stream
            .on("data", (chunk) => {
                total += chunk.byteLength;

                if (total > maxBytes) {
                    stream.pause();
                    reject(new WorkflowBundleError("too-large"));

                    return;
                }

                chunks.push(chunk);
            })
            .on("end", () => {
                const bytes = new Uint8Array(total);
                let offset = 0;

                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }

                resolve(bytes);
            })
            .on("error", reject)
            // A JSZip stream starts paused.
            .resume();
    });

const normalizeContentType = (value: string | null): string => value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

/** Downloads a signed asset URL; `undefined` when the server does not answer with a success status. */
export const downloadBundleSource = async (url: string): Promise<BundleSource | undefined> => {
    const response = await fetch(url);

    if (!response.ok) {
        await response.body?.cancel();

        return undefined;
    }

    return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: normalizeContentType(response.headers.get("content-type")) };
};

const decodeDataUrl = (url: string): BundleSource | undefined => {
    const match = DATA_URL.exec(url);

    if (!match) {
        return undefined;
    }

    try {
        return { bytes: Uint8Array.from(atob(match[2]!), (character) => character.codePointAt(0)!), contentType: match[1]!.toLowerCase() };
    } catch {
        // Malformed base64: the caller counts this asset as skipped rather than failing the whole export.
        return undefined;
    }
};

/** The archive paths the nodes reference, each counted once: a file's id or an inline image's path. */
const referencedAssetPaths = (nodes: ReadonlyArray<WorkflowNode>): Set<string> => {
    const paths = new Set<string>();

    for (const node of nodes) {
        for (const reference of ASSET_REFERENCES) {
            const inline = reference.inlinePath === undefined ? undefined : node.data[reference.inlinePath];
            const path = [getAt(node.data, reference.idPath), inline].find(isAssetPath);

            if (path !== undefined) {
                paths.add(path);
            }
        }
    }

    return paths;
};

const isValidNode = (node: unknown): node is WorkflowNode =>
    isRecord(node) &&
    typeof node.id === "string" &&
    typeof node.type === "string" &&
    isRecord(node.position) &&
    typeof node.position.x === "number" &&
    typeof node.position.y === "number" &&
    isRecord(node.data);

/** Checks the manifest shape and returns it as workflow content. Throws a {@link WorkflowBundleError}. */
const parseDocument = (value: unknown): { bundled: boolean; content: WorkflowContent } => {
    if (!isRecord(value)) {
        throw new WorkflowBundleError("not-workflow");
    }

    const bundled = value.format !== undefined;

    if (bundled && value.format !== WORKFLOW_BUNDLE_FORMAT) {
        throw new WorkflowBundleError("not-workflow");
    }

    if (bundled && value.version !== WORKFLOW_BUNDLE_VERSION) {
        throw new WorkflowBundleError("unknown-version");
    }

    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
        throw new WorkflowBundleError("not-workflow");
    }

    if (value.nodes.length > MAX_BUNDLE_NODES) {
        throw new WorkflowBundleError("too-many-nodes");
    }

    for (const node of value.nodes) {
        if (!isValidNode(node)) {
            throw new WorkflowBundleError("invalid-node");
        }

        if (!Object.hasOwn(NODE_CONFIGS, node.type)) {
            throw new WorkflowBundleError("unknown-node-type");
        }
    }

    // Each referenced asset is one archive file to read and one upload, so a manifest naming more than the cap is refused before any is read.
    if (referencedAssetPaths(value.nodes as WorkflowNode[]).size > MAX_BUNDLE_ASSETS) {
        throw new WorkflowBundleError("too-many-entries");
    }

    for (const edge of value.edges) {
        if (!isRecord(edge) || typeof edge.source !== "string" || typeof edge.target !== "string") {
            throw new WorkflowBundleError("invalid-node");
        }
    }

    const viewport = isRecord(value.viewport) ? (value.viewport as WorkflowContent["viewport"]) : undefined;

    return {
        bundled,
        content: {
            edges: value.edges as WorkflowContent["edges"],
            nodes: value.nodes as WorkflowNode[],
            viewport,
        },
    };
};

const isZipBytes = (bytes: Uint8Array): boolean => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/**
 * Reads a workflow the user picked: a bundle `.zip`, or a plain `.json` (the
 * format before bundles, or a `workflow.json` taken out of one). Throws
 * {@link WorkflowBundleError} with a translatable message.
 */
export const readWorkflowBundle = async (file: File, { loadZip }: ReadBundleOptions): Promise<WorkflowBundle> => {
    if (file.size > MAX_BUNDLE_BYTES) {
        throw new WorkflowBundleError("too-large");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    if (!isZipBytes(bytes)) {
        const text = new TextDecoder().decode(bytes);
        let parsed: unknown;

        try {
            parsed = JSON.parse(text);
        } catch {
            throw new WorkflowBundleError("not-workflow");
        }

        return { ...parseDocument(parsed), readAsset: async () => undefined };
    }

    const zip = await loadZip(bytes.buffer);
    const names = Object.keys(zip.files);

    if (names.length > MAX_BUNDLE_ENTRIES) {
        throw new WorkflowBundleError("too-many-entries");
    }

    if (names.some((name) => isUnsafeEntryName(name))) {
        throw new WorkflowBundleError("unsafe-path");
    }

    const manifest = zip.files[MANIFEST_PATH];

    if (!manifest || manifest.dir) {
        throw new WorkflowBundleError("not-workflow");
    }

    const manifestBytes = await readEntryCapped(manifest, MAX_MANIFEST_BYTES);
    let parsed: unknown;

    try {
        parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
        throw new WorkflowBundleError("not-workflow");
    }

    // The inflated bytes of every asset read so far, against the one budget for the whole archive.
    let inflatedBytes = 0;

    return {
        ...parseDocument(parsed),
        // Looked up by the exact name the manifest gave, one at a time, so an archive
        // never inflates more than one asset at once. The hash check is the integrity
        // check: the name is the digest the exporter wrote.
        readAsset: async (path) => {
            if (!isAssetPath(path)) {
                return undefined;
            }

            const entry = zip.files[path];
            const extension = path.slice(path.lastIndexOf(".") + 1);
            const contentType = ASSET_TYPE_BY_EXTENSION.get(extension);

            if (!entry || entry.dir || !contentType) {
                return undefined;
            }

            const assetBytes = await readEntryCapped(entry, Math.min(chatAttachmentLimit(contentType).maxBytes, ASSET_BYTE_BUDGET - inflatedBytes));

            inflatedBytes += assetBytes.byteLength;

            if (assetBytes.byteLength === 0) {
                throw new WorkflowBundleError("asset-mismatch");
            }

            if (path !== `assets/${await sha256Hex(assetBytes)}.${extension}`) {
                throw new WorkflowBundleError("asset-mismatch");
            }

            return { bytes: assetBytes, contentType };
        },
    };
};

/**
 * Imports a bundle's referenced assets through `store` (one at a time) and rewrites
 * the nodes to the new references. A reference that cannot be read or stored is
 * dropped from its node and counted in `skipped`, so the rest of the workflow still loads.
 * An asset past its size cap, or an archive past its total asset budget, stops the import
 * with a `too-large` {@link WorkflowBundleError}.
 */
export const importWorkflowBundle = async (
    bundle: WorkflowBundle,
    store: (file: File) => Promise<StoredAsset>,
): Promise<{ content: WorkflowContent; skipped: number }> => {
    let skipped = 0;

    const storedAsset = memoAsync(async (path: string): Promise<StoredAsset | undefined> => {
        const source = await bundle.readAsset(path).catch((error: unknown) => {
            // An archive past its size limits stops the import. Any other unreadable asset costs its node the file and nothing more.
            if (error instanceof WorkflowBundleError && error.code === "too-large") {
                throw error;
            }

            return undefined;
        });

        try {
            return source ? await store(new File([source.bytes], path.slice("assets/".length), { type: source.contentType })) : undefined;
        } catch {
            // A failed asset (a rate-limited upload, a rejected type) costs its node the file and nothing more.
            return undefined;
        }
    });

    const importReference = async (fields: Fields, reference: AssetReference): Promise<Fields> => {
        let next = fields;
        const id = getAt(fields, reference.idPath);

        // A raw id in the bundle format names a file in the exporter's account; nothing here can use it.
        if (bundle.bundled && typeof id === "string" && !isAssetPath(id)) {
            next = setAt(next, reference.idPath, undefined);
        }

        const inline = reference.inlinePath === undefined ? undefined : next[reference.inlinePath];
        const path = [getAt(next, reference.idPath), inline].find((value): value is string => isAssetPath(value));

        if (path === undefined) {
            return next;
        }

        const asset = await storedAsset(path);

        if (!asset) {
            skipped += 1;
        }

        if (reference.inlinePath !== undefined) {
            next = setAt(next, [reference.inlinePath], undefined);
        }

        next = setAt(next, reference.idPath, asset?.fileId);

        return reference.urlPath === undefined ? next : setAt(next, [reference.urlPath], asset?.url);
    };

    const nodes: WorkflowNode[] = [];

    for (const node of bundle.content.nodes) {
        let fields: Fields = { ...node.data };

        for (const reference of ASSET_REFERENCES) {
            fields = await importReference(fields, reference);
        }

        nodes.push({ ...node, data: fields } as WorkflowNode);
    }

    return { content: { ...bundle.content, nodes }, skipped };
};

/**
 * Builds the bundle for `content`. `signUrl` answers a fresh signed URL for a file the
 * caller holds a grant for (null otherwise); `fetchBytes` downloads it. A reference that
 * cannot be bundled is removed from its node and counted in `skipped`.
 */
export const exportWorkflowBundle = async (
    content: WorkflowContent,
    dependencies: {
        createZip: () => Promise<JsZipWriter>;
        fetchBytes: (url: string) => Promise<BundleSource | undefined>;
        signUrl: (fileId: string) => Promise<string | null>;
    },
): Promise<{ blob: Blob; skipped: number }> => {
    const assets = new Map<string, Uint8Array<ArrayBuffer>>();
    let totalBytes = 0;
    let skipped = 0;

    // Records the bytes under their digest and answers the path, or undefined when the type or limits
    // rule them out. Identical files share one entry.
    const addAsset = async (source: BundleSource): Promise<string | undefined> => {
        const extension = EXTENSION_BY_TYPE.get(source.contentType);

        if (!extension || source.bytes.byteLength > chatAttachmentLimit(source.contentType).maxBytes) {
            return undefined;
        }

        const path = `assets/${await sha256Hex(source.bytes)}.${extension}`;

        if (!assets.has(path)) {
            // The manifest and the zip's own headers come out of the same archive cap import reads against.
            if (assets.size >= MAX_BUNDLE_ASSETS || totalBytes + source.bytes.byteLength > ASSET_BYTE_BUDGET) {
                return undefined;
            }

            assets.set(path, source.bytes);
            totalBytes += source.bytes.byteLength;
        }

        return path;
    };

    const pathForFile = memoAsync(async (fileId: string): Promise<string | undefined> => {
        try {
            const url = await dependencies.signUrl(fileId);
            const source = url ? await dependencies.fetchBytes(url) : undefined;

            return source ? await addAsset(source) : undefined;
        } catch {
            // A file that cannot be fetched is left out, the same as one the owner no longer holds.
            return undefined;
        }
    });

    const bundleNode = async (node: WorkflowNode): Promise<WorkflowNode> => {
        const original: Fields = { ...node.data };
        let fields: Fields = { ...original };

        for (const reference of ASSET_REFERENCES) {
            const id = getAt(original, reference.idPath);
            const inline = reference.inlinePath === undefined ? undefined : original[reference.inlinePath];

            // Signed and blob URLs expire or are local to this browser; the import sets them again.
            if (reference.urlPath !== undefined) {
                fields = setAt(fields, [reference.urlPath], undefined);
            }

            if (reference.inlinePath !== undefined) {
                fields = setAt(fields, [reference.inlinePath], undefined);
            }

            if (typeof id === "string") {
                const path = await pathForFile(id);

                fields = setAt(fields, reference.idPath, path);

                if (path === undefined) {
                    skipped += 1;
                }
            } else if (reference.inlinePath !== undefined && typeof inline === "string") {
                if (inline.startsWith("data:")) {
                    const source = decodeDataUrl(inline);
                    const path = source ? await addAsset(source) : undefined;

                    fields = setAt(fields, [reference.inlinePath], path);

                    if (path === undefined) {
                        skipped += 1;
                    }
                } else {
                    fields = setAt(fields, [reference.inlinePath], inline);
                }
            }
        }

        return { ...node, data: fields } as WorkflowNode;
    };

    const nodes: WorkflowNode[] = [];

    for (const node of content.nodes) {
        nodes.push(await bundleNode(node));
    }

    const manifest = {
        edges: content.edges,
        format: WORKFLOW_BUNDLE_FORMAT,
        nodes,
        version: WORKFLOW_BUNDLE_VERSION,
        viewport: content.viewport,
    };
    const manifestText = JSON.stringify(manifest, null, 2);

    // Import refuses a manifest past this size, so an export must not produce one.
    if (new TextEncoder().encode(manifestText).byteLength > MAX_MANIFEST_BYTES) {
        throw new WorkflowBundleError("too-large");
    }

    const zip = await dependencies.createZip();

    zip.file(MANIFEST_PATH, manifestText);

    for (const [path, bytes] of assets) {
        zip.file(path, bytes);
    }

    return { blob: await zip.generateAsync({ type: "blob" }), skipped };
};
