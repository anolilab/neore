/**
 * The BUILT Worker (`build/index.js` + `build/index_bg.wasm`, from
 * `pnpm run build:worker`) in workerd, through wrangler's test harness — the
 * same module the backend binds and Alchemy deploys. `cargo test` covers the
 * shaping on the host; this proves the wasm build behaves the same.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestHarness } from "wrangler";
import { createTestHarness } from "wrangler";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));

/** 25 MiB — `MAX_DOCUMENT_BYTES` in `src/shape.rs`. */
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

interface ExtractBody {
    content: string;
    metadata: { format?: { format_type?: string } };
    mimeType: string;
    tables: { markdown: string; pageNumber: number }[];
}

if (!existsSync(new URL("../build/index.js", import.meta.url))) {
    throw new Error("build/index.js is missing — run `pnpm --filter document-parser run build:worker` first (vis runs it before `test`).");
}

describe("document-parser Worker", () => {
    let server: TestHarness;

    const extract = async (body: RequestInit["body"], contentType: string): Promise<Response> =>
        await server.fetch("https://document-parser.internal/extract", { body, headers: { "content-type": contentType }, method: "POST" });

    beforeAll(async () => {
        server = createTestHarness({
            root,
            // Inline, so the harness loads the prebuilt module instead of running
            // `build.command` (a multi-minute release build) on every start.
            workers: [{ config: { compatibility_date: "2026-09-01", main: "build/index.js", name: "document-parser" } }],
        });
        await server.listen();
    });

    afterAll(async () => {
        await server.close();
    });

    it("answers /health and /health/live", async () => {
        const health = await server.fetch("https://document-parser.internal/health");

        expect(health.status).toBe(200);
        await expect(health.json()).resolves.toMatchObject({ healthy: true, status: "ok" });

        const live = await server.fetch("https://document-parser.internal/health/live");

        await expect(live.json()).resolves.toStrictEqual({ status: "live" });
    });

    it("extracts a PDF", async () => {
        const response = await extract(fixture("sample.pdf"), "application/pdf");
        const body = (await response.json()) as ExtractBody;

        expect(response.status).toBe(200);
        expect(body.mimeType).toBe("application/pdf");
        expect(body.content).toContain("The capybara sits by the river.");
        expect(body.tables).toStrictEqual([]);
        expect(body.metadata).toBeTypeOf("object");
    });

    it("extracts a DOCX without xberg's heading attributes", async () => {
        const response = await extract(fixture("sample.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        const body = (await response.json()) as ExtractBody;

        expect(response.status).toBe(200);
        expect(body.content).toContain("Quarterly Report\n");
        expect(body.content).toContain("zebrafish");
        expect(body.content).not.toContain("style_name");
        expect(body.tables).toStrictEqual([{ markdown: "| Name | Score |\n| --- | --- |\n| Ada | 42 |\n", pageNumber: 1 }]);
    });

    it("extracts an XLSX with its table", async () => {
        const response = await extract(fixture("sample.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        const body = (await response.json()) as ExtractBody;

        expect(response.status).toBe(200);
        expect(body.content).toContain("platypus");
        expect(body.tables[0]?.markdown).toContain("| wombat | 3 |");
    });

    it("extracts a PPTX", async () => {
        const response = await extract(fixture("sample.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
        const body = (await response.json()) as ExtractBody;

        expect(response.status).toBe(200);
        expect(body.content).toContain("narwhal");
    });

    it("reads an unsupported text type as plain text", async () => {
        const response = await extract("def hello():\n    return 'world'\n", "text/x-python");
        const body = (await response.json()) as ExtractBody;

        expect(response.status).toBe(200);
        expect(body.content).toContain("def hello()");
    });

    it("refuses an empty body", async () => {
        const response = await extract(new Uint8Array(0), "application/pdf");

        expect(response.status).toBe(400);
    });

    it("refuses a document over 25 MB with a 413", async () => {
        const response = await extract(new Uint8Array(MAX_DOCUMENT_BYTES + 1), "application/pdf");

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toStrictEqual({
            details: "Documents can be at most 25 MB.",
            error: "File too large",
            maxBytes: MAX_DOCUMENT_BYTES,
        });
    });

    it("accepts a document of exactly 25 MB past the size check", async () => {
        // Not a real document, so extraction fails — but with a 500, not a 413.
        const response = await extract(new Uint8Array(MAX_DOCUMENT_BYTES), "application/x-unknown");

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({ error: "Extraction failed" });
    });

    // LAST: the Worker answers 413 while the client is still sending, and the
    // harness's connection does not survive that for a following request.
    it("counts a streamed body without a Content-Length", async () => {
        const chunk = new Uint8Array(1024 * 1024);
        let sent = 0;
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- stable since Node 22.15; the engines range says 22.x
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent > MAX_DOCUMENT_BYTES) {
                    controller.close();

                    return;
                }

                sent += chunk.byteLength;
                controller.enqueue(chunk);
            },
        });
        const response = await server.fetch("https://document-parser.internal/extract", {
            body,
            duplex: "half",
            headers: { "content-type": "application/pdf" },
            method: "POST",
        } as RequestInit);

        expect(response.status).toBe(413);
    });
});
