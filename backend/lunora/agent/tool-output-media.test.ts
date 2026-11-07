import { describe, expect, it, vi } from "vitest";

import { BROWSER_TOOL, CODE_TOOL, INLINE_FALLBACK_BYTES, offloadToolOutputMedia } from "./tool-output-media";

const BUDGET = 64;
const MCP_TOOL = "mcp_files__render";
/** Base64 of `bytes` zero bytes. */
const base64Of = (bytes: number): string => Buffer.alloc(bytes).toString("base64");
const LARGE = base64Of(BUDGET * 4);
const SMALL = base64Of(BUDGET / 2);
const keyOf = (n: number): string => `agent-files/${String(n).padStart(64, "0")}`;

const fakeStore = () => {
    let next = 0;

    return vi.fn(async (_bytes: Uint8Array<ArrayBuffer>, _mediaType: string) => {
        next += 1;

        return { fileId: `file-${String(next)}`, storageId: keyOf(next) };
    });
};

describe(offloadToolOutputMedia, () => {
    it("moves an MCP image, audio and resource blob past the budget to storage, with their own media types", async () => {
        const store = fakeStore();
        const output = {
            content: [
                { text: "done", type: "text" },
                { data: LARGE, mimeType: "image/png", type: "image" },
                { data: LARGE, mimeType: "audio/wav", type: "audio" },
                { resource: { blob: LARGE, mimeType: "application/pdf", uri: "file:///r.pdf" }, type: "resource" },
            ],
            isError: false,
        };

        const result = await offloadToolOutputMedia(MCP_TOOL, output, store, BUDGET);

        expect(result.fileIds).toStrictEqual(["file-1", "file-2", "file-3"]);
        expect(result.output).toStrictEqual({
            content: [
                { text: "done", type: "text" },
                { data: `storage:${keyOf(1)}`, mimeType: "image/png", type: "image" },
                { data: `storage:${keyOf(2)}`, mimeType: "audio/wav", type: "audio" },
                { resource: { blob: `storage:${keyOf(3)}`, mimeType: "application/pdf", uri: "file:///r.pdf" }, type: "resource" },
            ],
            isError: false,
        });
        expect(store.mock.calls.map(([bytes, mediaType]) => [bytes.byteLength, mediaType])).toStrictEqual([
            [BUDGET * 4, "image/png"],
            [BUDGET * 4, "audio/wav"],
            [BUDGET * 4, "application/pdf"],
        ]);
    });

    it("moves the browser screenshot to a field only the server writes", async () => {
        const store = fakeStore();
        const result = await offloadToolOutputMedia(BROWSER_TOOL, { screenshot: LARGE, screenshotFormat: "jpeg", title: "Page" }, store, BUDGET);

        expect(result.output).toStrictEqual({ screenshotFormat: "jpeg", screenshotUrl: `storage:${keyOf(1)}`, title: "Page" });
        expect(store.mock.calls[0]?.[1]).toBe("image/jpeg");
    });

    it("moves the code tool's raster images to their own `url`, keeping SVG markup and text inline", async () => {
        const store = fakeStore();
        const svg = `<svg>${"x".repeat(BUDGET * 4)}</svg>`;
        const result = await offloadToolOutputMedia(
            CODE_TOOL,
            {
                results: [
                    { format: "png", type: "image", value: LARGE },
                    { format: "svg", type: "image", value: svg },
                    { type: "text", value: LARGE },
                ],
                stderr: "",
                stdout: "",
            },
            store,
            BUDGET,
        );

        expect(result.output).toStrictEqual({
            results: [
                { format: "png", type: "image", url: `storage:${keyOf(1)}`, value: "" },
                { format: "svg", type: "image", value: svg },
                { type: "text", value: LARGE },
            ],
            stderr: "",
            stdout: "",
        });
    });

    it("reads the browser and code shapes only from those tools", async () => {
        const store = fakeStore();
        const output = { results: [{ format: "png", type: "image", value: LARGE }], screenshot: LARGE, screenshotFormat: "png" };

        const result = await offloadToolOutputMedia(MCP_TOOL, output, store, BUDGET);

        expect(result.output).toBe(output);
        expect(store).not.toHaveBeenCalled();
    });

    it("returns the same value when nothing is over the budget", async () => {
        const store = fakeStore();
        const output = { content: [{ data: SMALL, mimeType: "image/png", type: "image" }] };

        const result = await offloadToolOutputMedia(MCP_TOOL, output, store, BUDGET);

        expect(result).toStrictEqual({ fileIds: [], output });
        expect(result.output).toBe(output);
        expect(store).not.toHaveBeenCalled();
    });

    it("leaves a look-alike reference, a URL or other non-base64 text exactly as the tool wrote it", async () => {
        const store = fakeStore();
        const output = {
            content: [
                { data: `storage:agent-files/${"f".repeat(64)}${"=".repeat(BUDGET * 2)}`, mimeType: "image/png", type: "image" },
                { data: `https://example.com/${"a".repeat(BUDGET * 4)}.png`, mimeType: "image/png", type: "image" },
                { data: "%".repeat(BUDGET * 4), mimeType: "image/png", type: "image" },
            ],
        };

        const result = await offloadToolOutputMedia(MCP_TOOL, output, store, BUDGET);

        expect(result.output).toBe(output);
        expect(store).not.toHaveBeenCalled();
    });

    it("stores anything but a passive media type as opaque bytes", async () => {
        const store = fakeStore();
        const item = (mimeType: string) => {
            return { data: LARGE, mimeType, type: "image" };
        };

        await offloadToolOutputMedia(MCP_TOOL, { content: [item("text/html"), item("image/svg+xml"), item("IMAGE/WEBP")] }, store, BUDGET);

        expect(store.mock.calls.map(([, mediaType]) => mediaType)).toStrictEqual(["application/octet-stream", "application/octet-stream", "image/webp"]);
    });

    it("keeps a small blob inline when storing fails, and drops one too large for the row", async () => {
        const store = vi.fn(async () => {
            throw new Error("R2 unavailable");
        });
        const huge = base64Of(INLINE_FALLBACK_BYTES + 3);

        const small = await offloadToolOutputMedia(BROWSER_TOOL, { screenshot: LARGE, screenshotFormat: "png" }, store, BUDGET);
        const large = await offloadToolOutputMedia(BROWSER_TOOL, { screenshot: huge, screenshotFormat: "png", title: "Page" }, store, BUDGET);

        expect(small).toStrictEqual({ fileIds: [], output: { screenshot: LARGE, screenshotFormat: "png" } });
        expect(large).toStrictEqual({ fileIds: [], output: { screenshotFormat: "png", title: "Page" } });
    });

    it("leaves text and non-object outputs alone", async () => {
        const store = fakeStore();

        expect(await offloadToolOutputMedia(MCP_TOOL, LARGE, store, BUDGET)).toStrictEqual({ fileIds: [], output: LARGE });
        expect(await offloadToolOutputMedia(MCP_TOOL, [LARGE], store, BUDGET)).toStrictEqual({ fileIds: [], output: [LARGE] });
        expect(store).not.toHaveBeenCalled();
    });
});
