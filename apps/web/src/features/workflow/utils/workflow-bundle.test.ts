import { chatAttachmentLimit } from "@neore/backend/document-limits";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsZipLike, JsZipWriter } from "@/lib/zip";
import { createJsZip, loadJsZip } from "@/lib/zip";

import type { WorkflowContent, WorkflowNode } from "../types";
import {
    ASSET_BYTE_BUDGET,
    downloadBundleSource,
    exportWorkflowBundle,
    importWorkflowBundle,
    MAX_BUNDLE_BYTES,
    MAX_BUNDLE_ENTRIES,
    readWorkflowBundle,
    WORKFLOW_BUNDLE_FORMAT,
    WorkflowBundleError,
} from "./workflow-bundle";

// The node registry is a module-level object of `msg` descriptors.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

const OPTIONS = { loadZip: loadJsZip };

const PNG_ASSET = /^assets\/[\da-f]{64}\.png$/u;
const PDF_ASSET = /^assets\/[\da-f]{64}\.pdf$/u;
const STORED_PNG = /^stored:[\da-f]{64}\.png$/u;
const STORED_PDF = /^stored:[\da-f]{64}\.pdf$/u;
const STORAGE_URL = /^https:\/\/storage\.test\//u;
const FILE_INDEX = /\/f(\d+)\?/u;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PNG_BASE64 = btoa(String.fromCodePoint(...PNG_BYTES));

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode =>
    ({ data: { label: id, ...data }, id, position: { x: 0, y: 0 }, type }) as WorkflowNode;

const asFile = (blob: Blob, name: string): Promise<File> => blob.arrayBuffer().then((buffer) => new File([buffer], name));

const zipFile = async (zip: JSZip): Promise<File> => asFile(await zip.generateAsync({ type: "blob" }), "w.zip");

const manifestZip = (nodes: WorkflowNode[]): JSZip => {
    const zip = new JSZip();

    zip.file("workflow.json", JSON.stringify({ edges: [], format: WORKFLOW_BUNDLE_FORMAT, nodes, version: 1 }));

    return zip;
};

const content = (nodes: WorkflowNode[]): WorkflowContent => {
    return { edges: [], nodes };
};

const sign = async (fileId: string): Promise<string | null> => (fileId === "missing" ? null : `https://storage.test/${fileId}?sig=1`);

const fetchBytes = async (url: string) => {
    if (url.includes("f1")) return { bytes: PNG_BYTES, contentType: "image/png" };

    if (url.includes("f2")) return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf" };

    // An audio asset: not on the upload allowlist, so it is left out.
    return { bytes: new Uint8Array([1, 2]), contentType: "audio/mpeg" };
};

const store = async (file: File) => {
    return { fileId: `stored:${file.name}`, url: `https://storage.test/${file.name}` };
};

describe("workflow bundle", () => {
    it("round-trips image and file references through a zip, re-storing each asset", async () => {
        const source = content([
            node("img", "image", { imageFileId: "f1", mode: "input" }),
            node("doc", "file", { fileId: "f2", fileName: "a.pdf", fileType: "application/pdf", fileUrl: "https://old" }),
            node("inline", "image", { imageUrl: `data:image/png;base64,${PNG_BASE64}`, mode: "input" }),
            node("audio", "file", { fileId: "audio", fileName: "a.mp3" }),
            node("text", "text", { content: "hi", mode: "input" }),
        ]);

        const exported = await exportWorkflowBundle(source, { createZip: createJsZip, fetchBytes, signUrl: sign });

        // The audio file is not bundled; the reference is dropped and counted.
        expect(exported.skipped).toBe(1);

        const archive = await JSZip.loadAsync(await exported.blob.arrayBuffer());
        const manifest = JSON.parse(await archive.file("workflow.json")!.async("string"));

        expect(manifest.format).toBe(WORKFLOW_BUNDLE_FORMAT);
        expect(manifest.version).toBe(1);
        expect(JSON.stringify(manifest)).not.toContain("storage.test");
        expect(manifest.nodes[0].data.imageFileId).toMatch(PNG_ASSET);
        expect(manifest.nodes[1].data.fileId).toMatch(PDF_ASSET);
        expect(manifest.nodes[1].data.fileUrl).toBeUndefined();
        expect(manifest.nodes[3].data.fileId).toBeUndefined();

        const bundle = await readWorkflowBundle(await asFile(exported.blob, "workflow.zip"), OPTIONS);
        const imported = await importWorkflowBundle(bundle, store);
        const [image, doc, inline, , text] = imported.content.nodes as WorkflowNode[];

        expect(imported.skipped).toBe(0);
        expect((image!.data as { imageFileId: string }).imageFileId).toMatch(STORED_PNG);
        expect((doc!.data as { fileId: string; fileUrl: string }).fileId).toMatch(STORED_PDF);
        expect((doc!.data as { fileUrl: string }).fileUrl).toMatch(STORAGE_URL);
        expect((inline!.data as { imageFileId: string }).imageFileId).toBe((image!.data as { imageFileId: string }).imageFileId);
        expect((inline!.data as { imageUrl?: string }).imageUrl).toBeUndefined();
        expect(text!.data).toMatchObject({ content: "hi" });
    });

    it("bundles captured video frames and re-stores them on import", async () => {
        const source = content([node("vid", "video", { frameFileIds: { end: "missing", picked: "f1", start: "f1" } })]);

        const exported = await exportWorkflowBundle(source, { createZip: createJsZip, fetchBytes, signUrl: sign });

        // The frame that no longer resolves is dropped and counted; the other two share one asset.
        expect(exported.skipped).toBe(1);

        const archive = await JSZip.loadAsync(await exported.blob.arrayBuffer());
        const manifest = JSON.parse(await archive.file("workflow.json")!.async("string"));

        expect(manifest.nodes[0].data.frameFileIds.start).toMatch(PNG_ASSET);
        expect(manifest.nodes[0].data.frameFileIds.picked).toBe(manifest.nodes[0].data.frameFileIds.start);
        expect(manifest.nodes[0].data.frameFileIds.end).toBeUndefined();

        const bundle = await readWorkflowBundle(await asFile(exported.blob, "workflow.zip"), OPTIONS);
        const imported = await importWorkflowBundle(bundle, store);
        const frames = (imported.content.nodes[0]!.data as { frameFileIds: Record<string, string> }).frameFileIds;

        expect(imported.skipped).toBe(0);
        expect(frames.start).toMatch(STORED_PNG);
        expect(frames.picked).toBe(frames.start);
        expect(frames.end).toBeUndefined();
    });

    it("drops a raw account frame id from a bundled workflow", async () => {
        const zip = manifestZip([node("vid", "video", { frameFileIds: { start: "raw-account-id" } })]);

        const imported = await importWorkflowBundle(await readWorkflowBundle(await zipFile(zip), OPTIONS), store);
        const [video] = imported.content.nodes as WorkflowNode[];

        expect(imported.skipped).toBe(0);
        expect((video!.data as { frameFileIds?: unknown }).frameFileIds).toBeUndefined();
    });

    it("rejects zip entries that would escape the archive root", async () => {
        for (const name of ["../x", "assets/../workflow.json", "/abs.json"]) {
            const zip = manifestZip([]);

            zip.file(name, "x");

            const file = await zipFile(zip);

            await expect(readWorkflowBundle(file, OPTIONS)).rejects.toBeInstanceOf(WorkflowBundleError);
        }
    });

    it("refuses an unknown format version with a clear error", async () => {
        const zip = new JSZip();

        zip.file("workflow.json", JSON.stringify({ edges: [], format: WORKFLOW_BUNDLE_FORMAT, nodes: [], version: 2 }));

        const error = await readWorkflowBundle(await zipFile(zip), OPTIONS).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(WorkflowBundleError);
        expect((error as WorkflowBundleError).code).toBe("unknown-version");
    });

    it("refuses a node type this app does not have", async () => {
        const file = await zipFile(manifestZip([node("x", "not-a-node")]));
        const error = await readWorkflowBundle(file, OPTIONS).catch((error_: unknown) => error_);

        expect((error as WorkflowBundleError).code).toBe("unknown-node-type");
    });

    it("caps the number of archive entries before reading any of them", async () => {
        const zip = manifestZip([]);

        for (let index = 0; index <= MAX_BUNDLE_ENTRIES; index += 1) {
            zip.file(`noise/${index}.txt`, "x");
        }

        await expect(readWorkflowBundle(await zipFile(zip), OPTIONS)).rejects.toBeInstanceOf(WorkflowBundleError);
    });

    it("rejects an asset whose bytes do not match its name", async () => {
        const zip = new JSZip();
        const name = `assets/${"0".repeat(64)}.png`;

        zip.file("workflow.json", JSON.stringify({ edges: [], format: WORKFLOW_BUNDLE_FORMAT, nodes: [], version: 1 }));
        zip.file(name, PNG_BYTES);

        const bundle = await readWorkflowBundle(await zipFile(zip), OPTIONS);

        await expect(bundle.readAsset(name)).rejects.toBeInstanceOf(WorkflowBundleError);
    });

    it("refuses a manifest that references more assets than the cap, before reading any of them", async () => {
        const assetPath = (index: number) => `assets/${index.toString(16).padStart(64, "0")}.png`;
        const nodesFor = (count: number) => Array.from({ length: count }, (_, index) => node(`n${index}`, "image", { imageFileId: assetPath(index) }));

        const over = await zipFile(manifestZip(nodesFor(101)));
        const atCap = await zipFile(manifestZip(nodesFor(100)));

        await expect(readWorkflowBundle(over, OPTIONS)).rejects.toMatchObject({ code: "too-many-entries" });
        await expect(readWorkflowBundle(atCap, OPTIONS)).resolves.toBeDefined();
    });

    it("stops the import at the first asset past the archive's total budget, even when each is within its own cap", async () => {
        // Under the asset cap, a bundle passes the total budget only with assets close to their per-type cap. Each asset
        // here is valid (its name is its digest), so the uploads before the budget run and the next one stops the import.
        const cap = chatAttachmentLimit("image/png").maxBytes;
        const fits = Math.floor(ASSET_BYTE_BUDGET / cap);
        const count = fits + 2;
        const digestOf = async (index: number) => {
            const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(cap).fill(index));

            return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        };
        const paths = await Promise.all(Array.from({ length: count }, async (_, index) => `assets/${await digestOf(index)}.png`));
        let opened = 0;

        // Every asset is `cap` bytes of its own index, emitted in chunks, the way JSZip's stream hands them out.
        const fakeEntry = (index: number, name: string) => {
            const listeners: Record<string, ((value?: Uint8Array) => void) | undefined> = {};
            const filled = new Uint8Array(1024 * 1024).fill(index);
            let paused = false;
            const stream = {
                on(event: string, listener: (value?: Uint8Array) => void) {
                    listeners[event] = listener;

                    return stream;
                },
                pause() {
                    paused = true;

                    return stream;
                },
                resume() {
                    for (let sent = 0; sent < cap && !paused; sent += filled.byteLength) {
                        listeners.data?.(filled);
                    }

                    if (!paused) {
                        listeners.end?.();
                    }

                    return stream;
                },
            };

            return {
                async: vi.fn(),
                dir: false,
                internalStream: () => {
                    opened += 1;

                    return stream;
                },
                name,
            };
        };
        const nodes = paths.map((path, index) => node(`n${index}`, "image", { imageFileId: path }));
        const withEntries = async (data: ArrayBuffer): Promise<JsZipLike> => {
            const zip = await loadJsZip(data);

            paths.forEach((path, index) => {
                zip.files[path] = fakeEntry(index, path);
            });

            return zip;
        };
        const stored = vi.fn(store);

        const bundle = await readWorkflowBundle(await zipFile(manifestZip(nodes)), { loadZip: withEntries });

        await expect(importWorkflowBundle(bundle, stored)).rejects.toMatchObject({ code: "too-large" });
        expect(stored).toHaveBeenCalledTimes(fits);
        // The asset that takes the total past the budget is the last one read.
        expect(opened).toBe(fits + 1);
    }, 60_000);

    it("reads an asset in chunks and stops at its size cap instead of inflating it whole", async () => {
        const name = `assets/${"0".repeat(64)}.png`;
        const cap = chatAttachmentLimit("image/png").maxBytes;
        const chunk = new Uint8Array(1024 * 1024);
        const listeners: Record<string, ((value?: Uint8Array) => void) | undefined> = {};
        let paused = false;
        let emitted = 0;

        // A stand-in for JSZip's entry stream, which emits on resume() until paused. The loop is bounded, so a
        // reader that never pauses ends in an "end" event and fails the assertions, rather than hanging.
        const stream = {
            on(event: string, listener: (value?: Uint8Array) => void) {
                listeners[event] = listener;

                return stream;
            },
            pause() {
                paused = true;

                return stream;
            },
            resume() {
                for (let index = 0; index < 100 && !paused; index += 1) {
                    emitted += 1;
                    listeners.data?.(chunk);
                }

                if (!paused) {
                    listeners.end?.();
                }

                return stream;
            },
        };
        const async = vi.fn(() => Promise.reject(new Error("the whole entry must not be inflated")));
        const entry = { async, dir: false, internalStream: () => stream, name };
        const withEntry = async (data: ArrayBuffer): Promise<JsZipLike> => {
            const zip = await loadJsZip(data);

            zip.files[name] = entry;

            return zip;
        };

        const bundle = await readWorkflowBundle(await zipFile(manifestZip([])), { loadZip: withEntry });
        const error = await bundle.readAsset(name).catch((error_: unknown) => error_);

        expect((error as WorkflowBundleError).code).toBe("too-large");
        expect(async).not.toHaveBeenCalled();
        expect(emitted).toBeLessThanOrEqual(Math.floor(cap / chunk.byteLength) + 1);
    });

    it("does not bundle a data URL whose type is an object prototype key", async () => {
        const source = content([node("inline", "image", { imageUrl: "data:constructor;base64,AAAA", mode: "input" })]);

        const exported = await exportWorkflowBundle(source, { createZip: createJsZip, fetchBytes, signUrl: sign });
        const archive = await JSZip.loadAsync(await exported.blob.arrayBuffer());

        expect(exported.skipped).toBe(1);
        expect(Object.keys(archive.files)).toEqual(["workflow.json"]);
    });

    it("skips an inline image with malformed base64 instead of failing the whole export", async () => {
        const source = content([
            node("bad", "image", { imageUrl: "data:image/png;base64,!!!not-base64!!!", mode: "input" }),
            node("good", "image", { imageUrl: `data:image/png;base64,${PNG_BASE64}`, mode: "input" }),
        ]);

        const exported = await exportWorkflowBundle(source, { createZip: createJsZip, fetchBytes, signUrl: sign });
        const archive = await JSZip.loadAsync(await exported.blob.arrayBuffer());

        expect(exported.skipped).toBe(1);
        expect(Object.keys(archive.files).filter((name) => PNG_ASSET.test(name))).toHaveLength(1);
    });

    it("reserves the zip's own headers out of the budget, and an asset near it still exports an importable bundle", async () => {
        // A 17 MiB cap: the 16 MiB manifest reserve leaves about 1 MiB. Two 520 KB images are 1,040,000 bytes, which fits
        // 1 MiB on their data alone but not with each entry's headers counted, so the second is skipped.
        const archiveBytes = 17 * 1024 * 1024;
        const images = Array.from({ length: 2 }, (_, index) => {
            const bytes = new Uint8Array(520_000).fill(index + 1);

            bytes.set(PNG_BYTES);

            return bytes;
        });
        const nodes = images.map((_, index) => node(`n${index}`, "image", { imageFileId: `f${index}`, mode: "input" }));
        const imageBytes = async (url: string) => {
            const index = Number(FILE_INDEX.exec(url)?.[1]);

            return { bytes: images[index]!, contentType: "image/png" };
        };

        const exported = await exportWorkflowBundle(content(nodes), { archiveBytes, createZip: createJsZip, fetchBytes: imageBytes, signUrl: sign });

        expect(exported.skipped).toBe(1);
        expect(exported.blob.size).toBeLessThanOrEqual(archiveBytes);

        const bundle = await readWorkflowBundle(await asFile(exported.blob, "workflow.zip"), OPTIONS);
        const imported = await importWorkflowBundle(bundle, store);
        const stored = (imported.content.nodes as WorkflowNode[]).filter((entry) => (entry.data as { imageFileId?: string }).imageFileId !== undefined);

        expect(imported.skipped).toBe(0);
        expect(stored).toHaveLength(1);
    });

    it("refuses to return an archive the import would refuse, whatever the budget said", async () => {
        const oversized = Object.defineProperty(new Blob(["x"]), "size", { value: MAX_BUNDLE_BYTES + 1 });
        const writer = { file: vi.fn(), generateAsync: vi.fn(async () => oversized) };

        await expect(
            exportWorkflowBundle(content([]), { createZip: async () => writer as unknown as JsZipWriter, fetchBytes, signUrl: sign }),
        ).rejects.toMatchObject({ code: "too-large" });
    });

    it("loads a legacy plain workflow JSON without assets", async () => {
        const legacy = { edges: [], nodes: [node("t", "text", { content: "hello", mode: "input" })] };
        const bundle = await readWorkflowBundle(new File([JSON.stringify(legacy)], "workflow.json"), OPTIONS);

        expect(bundle.bundled).toBe(false);
        expect(bundle.content.nodes).toHaveLength(1);
        expect(await bundle.readAsset("assets/x.png")).toBeUndefined();
    });
});

describe("importing an external image URL", () => {
    it("keeps an https URL and drops, and counts, every other one", async () => {
        const urls = [
            "https://cdn.example/keep.png",
            // A plain http URL is the case under test, not a link to fetch.
            // eslint-disable-next-line unicorn/prefer-https
            "http://cdn.example/plain.png",
            "ftp://cdn.example/file.png",
            // A script URL is the case under test: it must never survive an import.
            // eslint-disable-next-line no-script-url
            "javascript:alert(1)",
            "data:image/png;base64,iVBORw0KGgo=",
            "not a url",
            "/relative.png",
        ];
        const legacy = { edges: [], nodes: urls.map((imageUrl, index) => node(`n${index}`, "image", { imageUrl, mode: "input" })) };
        const bundle = await readWorkflowBundle(new File([JSON.stringify(legacy)], "workflow.json"), OPTIONS);
        const imported = await importWorkflowBundle(bundle, store);
        const kept = imported.content.nodes.map((candidate) => (candidate.data as { imageUrl?: string }).imageUrl);

        expect(kept).toStrictEqual(["https://cdn.example/keep.png", undefined, undefined, undefined, undefined, undefined, undefined]);
        expect(imported.skipped).toBe(6);
    });
});

describe("importing a bundled file URL", () => {
    it("drops a file URL that is not https when its file id did not survive, and counts it", async () => {
        const legacy = {
            edges: [],
            nodes: [
                // eslint-disable-next-line unicorn/prefer-https -- the case under test: a plain http file URL must not survive an import.
                node("plain", "file", { fileName: "a.pdf", fileUrl: "http://cdn.example/a.pdf" }),
                node("secure", "file", { fileName: "b.pdf", fileUrl: "https://cdn.example/b.pdf" }),
            ],
        };
        const bundle = await readWorkflowBundle(new File([JSON.stringify(legacy)], "workflow.json"), OPTIONS);
        const imported = await importWorkflowBundle(bundle, store);
        const [plain, secure] = imported.content.nodes as WorkflowNode[];

        expect(plain!.data).not.toHaveProperty("fileUrl");
        expect(secure!.data).toMatchObject({ fileUrl: "https://cdn.example/b.pdf" });
        expect(imported.skipped).toBe(1);
    });
});

describe("downloadBundleSource", () => {
    const cap = chatAttachmentLimit("image/png").maxBytes;
    const MIB = 1024 * 1024;

    const stubFetch = (response: Response) => {
        const fetchMock = vi.fn(async () => response);

        vi.stubGlobal("fetch", fetchMock);

        return fetchMock;
    };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("reads an asset under its type's cap, and refuses redirects", async () => {
        const fetchMock = stubFetch(new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }));

        expect(await downloadBundleSource("https://storage.test/a")).toStrictEqual({ bytes: PNG_BYTES, contentType: "image/png" });
        expect(fetchMock).toHaveBeenCalledWith("https://storage.test/a", { redirect: "error" });
    });

    it("refuses an asset whose declared length is past the cap, without reading its body", async () => {
        let pulled = 0;
        // No eager pull: a stream pulls once on creation unless its high-water mark is zero.
        const body = new ReadableStream(
            {
                pull(controller) {
                    pulled += 1;
                    controller.enqueue(new Uint8Array(MIB));
                },
            },
            { highWaterMark: 0 },
        );

        stubFetch(new Response(body, { headers: { "content-length": String(cap + 1), "content-type": "image/png" } }));

        expect(await downloadBundleSource("https://storage.test/big")).toBeUndefined();
        expect(pulled).toBe(0);
    });

    it("stops reading a body with no declared length at the cap, and cancels the rest", async () => {
        let cancelled = false;
        let pulled = 0;
        const chunks = Math.ceil(cap / MIB) + 50;
        const body = new ReadableStream({
            cancel() {
                cancelled = true;
            },
            pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(MIB));

                if (pulled >= chunks) {
                    controller.close();
                }
            },
        });

        stubFetch(new Response(body, { headers: { "content-type": "image/png" } }));

        expect(await downloadBundleSource("https://storage.test/streamed")).toBeUndefined();
        expect(cancelled).toBe(true);
        expect(pulled).toBeLessThan(chunks);
    });

    it("refuses a type with no asset rule before reading its body", async () => {
        stubFetch(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg" } }));

        expect(await downloadBundleSource("https://storage.test/audio")).toBeUndefined();
    });
});
