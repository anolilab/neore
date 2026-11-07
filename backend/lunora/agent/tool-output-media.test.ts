import { describe, expect, it, vi } from "vitest";

import { BROWSER_TOOL, CODE_TOOL, INLINE_FALLBACK_CHARS, offloadToolOutputMedia, stepInlineBudget } from "./tool-output-media";

const BUDGET = 64;
const MCP_TOOL = "mcp_files__render";
/** Base64 of `bytes` zero bytes. */
const base64Of = (bytes: number): string => Buffer.alloc(bytes).toString("base64");
const LARGE = base64Of(BUDGET * 4);
const SMALL = base64Of(BUDGET / 2);
const keyOf = (n: number): string => `agent-files/${String(n).padStart(64, "0")}`;

const fakeStore = () => {
    let next = 0;

    return vi.fn(async (_base64: string, _mediaType: string) => {
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

        const result = await offloadToolOutputMedia(MCP_TOOL, output, store, stepInlineBudget(), BUDGET);

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
        expect(store.mock.calls).toStrictEqual([
            [LARGE, "image/png"],
            [LARGE, "audio/wav"],
            [LARGE, "application/pdf"],
        ]);
    });

    it("moves the browser screenshot to a field only the server writes", async () => {
        const store = fakeStore();
        const result = await offloadToolOutputMedia(
            BROWSER_TOOL,
            { screenshot: LARGE, screenshotFormat: "jpeg", title: "Page" },
            store,
            stepInlineBudget(),
            BUDGET,
        );

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
            stepInlineBudget(),
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

        const result = await offloadToolOutputMedia(MCP_TOOL, output, store, stepInlineBudget(), BUDGET);

        expect(result.output).toBe(output);
        expect(store).not.toHaveBeenCalled();
    });

    it("returns the same value when nothing is over the budget", async () => {
        const store = fakeStore();
        const output = { content: [{ data: SMALL, mimeType: "image/png", type: "image" }] };

        const result = await offloadToolOutputMedia(MCP_TOOL, output, store, stepInlineBudget(), BUDGET);

        expect(result).toStrictEqual({ fileIds: [], output });
        expect(result.output).toBe(output);
        expect(store).not.toHaveBeenCalled();
    });

    it("stores small blobs too once the step's row has kept its share of them inline", async () => {
        const store = fakeStore();
        const image = (data: string) => {
            return { data, mimeType: "image/png", type: "image" };
        };
        const step = { fallbackChars: 0, smallChars: SMALL.length };

        const result = await offloadToolOutputMedia(MCP_TOOL, { content: [image(SMALL), image(SMALL)] }, store, step, BUDGET);

        expect(result.output).toStrictEqual({ content: [image(SMALL), image(`storage:${keyOf(1)}`)] });
        expect(step.smallChars).toBe(0);
    });

    it("keeps a small blob whose store failed while the fallback lasts, then drops and counts the rest", async () => {
        const store = vi.fn(async () => {
            throw new Error("R2 unavailable");
        });
        const image = (data: string) => {
            return { data, mimeType: "image/png", type: "image" };
        };

        const result = await offloadToolOutputMedia(
            MCP_TOOL,
            { content: [image(SMALL), image(SMALL)] },
            store,
            { fallbackChars: SMALL.length, smallChars: 0 },
            BUDGET,
        );

        expect(result.output).toStrictEqual({ content: [image(SMALL), image("")], unsavedMedia: 1 });
    });

    it("keeps SVG and text that is not plain base64 only while the row's small share lasts", async () => {
        const store = fakeStore();
        const svg = `<svg>${"x".repeat(BUDGET)}</svg>`;
        const wrapped = `${SMALL}\n${SMALL}`;
        const step = { fallbackChars: 0, smallChars: svg.length };

        const code = await offloadToolOutputMedia(
            CODE_TOOL,
            {
                results: [
                    { format: "svg", type: "image", value: svg },
                    { format: "svg", type: "image", value: svg },
                ],
            },
            store,
            step,
            BUDGET,
        );
        const mcp = await offloadToolOutputMedia(MCP_TOOL, { content: [{ data: wrapped, mimeType: "image/png", type: "image" }] }, store, step, BUDGET);

        expect(code.output).toStrictEqual({
            results: [
                { format: "svg", type: "image", value: svg },
                { format: "svg", type: "image", value: "" },
            ],
            unsavedMedia: 1,
        });
        expect(mcp.output).toStrictEqual({ content: [{ data: "", mimeType: "image/png", type: "image" }], unsavedMedia: 1 });
        expect(store).not.toHaveBeenCalled();
    });

    it("stores base64 sent with line breaks or as a data URL, from its plain bytes", async () => {
        const store = fakeStore();
        const wrapped = LARGE.replaceAll(/(.{76})/gu, "$1\r\n");
        const output = {
            content: [
                { data: wrapped, mimeType: "image/png", type: "image" },
                { data: `data:image/png;base64,${LARGE}`, mimeType: "image/png", type: "image" },
            ],
        };

        const result = await offloadToolOutputMedia(MCP_TOOL, output, store, stepInlineBudget(), BUDGET);

        expect(store.mock.calls).toStrictEqual([
            [LARGE, "image/png"],
            [LARGE, "image/png"],
        ]);
        expect(result.output).toStrictEqual({
            content: [
                { data: `storage:${keyOf(1)}`, mimeType: "image/png", type: "image" },
                { data: `storage:${keyOf(2)}`, mimeType: "image/png", type: "image" },
            ],
        });
    });

    it("charges a reference-shaped string to the row like any text, so an oversized one is dropped", async () => {
        const store = fakeStore();
        const oversized = `storage:${"x".repeat(BUDGET * 4)}`;
        const step = { fallbackChars: 0, smallChars: BUDGET };

        const result = await offloadToolOutputMedia(MCP_TOOL, { content: [{ data: oversized, mimeType: "image/png", type: "image" }] }, store, step, BUDGET);

        expect(result.output).toStrictEqual({ content: [{ data: "", mimeType: "image/png", type: "image" }], unsavedMedia: 1 });
        expect(store).not.toHaveBeenCalled();
    });

    it("drops a link field the browser or code tool returned itself, so only a stored image becomes one", async () => {
        const store = fakeStore();
        const tracker = "https://tracker.example/p.png";

        const browser = await offloadToolOutputMedia(
            BROWSER_TOOL,
            { screenshot: SMALL, screenshotFormat: "png", screenshotUrl: tracker },
            store,
            stepInlineBudget(),
            BUDGET,
        );
        const code = await offloadToolOutputMedia(
            CODE_TOOL,
            {
                results: [
                    { format: "png", type: "image", url: tracker, value: SMALL },
                    { type: "text", url: tracker, value: "1" },
                ],
            },
            store,
            stepInlineBudget(),
            BUDGET,
        );

        const svgBrowser = await offloadToolOutputMedia(
            BROWSER_TOOL,
            { screenshotFormat: "svg", screenshotUrl: tracker, success: true },
            store,
            stepInlineBudget(),
            BUDGET,
        );

        expect(browser.output).toStrictEqual({ screenshot: SMALL, screenshotFormat: "png" });
        expect(svgBrowser.output).toStrictEqual({ screenshotFormat: "svg", success: true });
        expect(code.output).toStrictEqual({
            results: [
                { format: "png", type: "image", value: SMALL },
                { type: "text", value: "1" },
            ],
        });
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

        const result = await offloadToolOutputMedia(MCP_TOOL, output, store, stepInlineBudget(), BUDGET);

        expect(result.output).toBe(output);
        expect(store).not.toHaveBeenCalled();
    });

    it("stores anything but a passive media type as opaque bytes", async () => {
        const store = fakeStore();
        const item = (mimeType: string) => {
            return { data: LARGE, mimeType, type: "image" };
        };

        await offloadToolOutputMedia(MCP_TOOL, { content: [item("text/html"), item("image/svg+xml"), item("IMAGE/WEBP")] }, store, stepInlineBudget(), BUDGET);

        expect(store.mock.calls.map(([, mediaType]) => mediaType)).toStrictEqual(["application/octet-stream", "application/octet-stream", "image/webp"]);
    });

    it("keeps blobs inline within one shared budget when storing fails, and counts the ones dropped", async () => {
        const store = vi.fn(async () => {
            throw new Error("R2 unavailable");
        });
        // 0.8 MiB of base64 each: one fits the inline budget, two do not.
        const big = base64Of(INLINE_FALLBACK_CHARS * 0.6);
        const image = (data: string) => {
            return { data, mimeType: "image/png", type: "image" };
        };

        const small = await offloadToolOutputMedia(BROWSER_TOOL, { screenshot: LARGE, screenshotFormat: "png" }, store, stepInlineBudget(), BUDGET);
        // Each fits the budget alone; together they would not, so the second is dropped.
        const two = await offloadToolOutputMedia(MCP_TOOL, { content: [image(big), image(big)] }, store, stepInlineBudget(), BUDGET);
        const screenshot = await offloadToolOutputMedia(
            BROWSER_TOOL,
            { screenshot: base64Of(INLINE_FALLBACK_CHARS), screenshotFormat: "png", title: "Page" },
            store,
            stepInlineBudget(),
            BUDGET,
        );

        expect(small).toStrictEqual({ fileIds: [], output: { screenshot: LARGE, screenshotFormat: "png" } });
        expect(two.output).toStrictEqual({ content: [image(big), image("")], unsavedMedia: 1 });
        expect(screenshot.output).toStrictEqual({ screenshotFormat: "png", title: "Page", unsavedMedia: 1 });
    });

    it("shares the inline budget across every tool result of a step, which saves them in one row", async () => {
        const store = vi.fn(async () => {
            throw new Error("R2 unavailable");
        });
        const big = base64Of(INLINE_FALLBACK_CHARS * 0.6);
        const step = stepInlineBudget();

        const first = await offloadToolOutputMedia(BROWSER_TOOL, { screenshot: big, screenshotFormat: "png" }, store, step, BUDGET);
        const second = await offloadToolOutputMedia(BROWSER_TOOL, { screenshot: big, screenshotFormat: "png" }, store, step, BUDGET);

        expect(first.output).toStrictEqual({ screenshot: big, screenshotFormat: "png" });
        expect(second.output).toStrictEqual({ screenshotFormat: "png", unsavedMedia: 1 });
    });

    it("drops media past the storage cap without trying to store it", async () => {
        const { STORE_MAX_BYTES } = await import("./client/files");
        const store = fakeStore();
        const huge = base64Of(STORE_MAX_BYTES + 3);

        const result = await offloadToolOutputMedia(BROWSER_TOOL, { screenshot: huge, screenshotFormat: "png" }, store, stepInlineBudget(), BUDGET);

        expect(result.output).toStrictEqual({ screenshotFormat: "png", unsavedMedia: 1 });
        expect(store).not.toHaveBeenCalled();
    });

    it("leaves text and non-object outputs alone", async () => {
        const store = fakeStore();

        expect(await offloadToolOutputMedia(MCP_TOOL, LARGE, store, stepInlineBudget(), BUDGET)).toStrictEqual({ fileIds: [], output: LARGE });
        expect(await offloadToolOutputMedia(MCP_TOOL, [LARGE], store, stepInlineBudget(), BUDGET)).toStrictEqual({ fileIds: [], output: [LARGE] });
        expect(store).not.toHaveBeenCalled();
    });
});
