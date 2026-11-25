import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { loadJsZip } from "@/lib/zip";

import {
    collectFolderDocuments,
    documentMimeType,
    encodeDocument,
    MAX_DOCUMENT_BYTES,
    MAX_DOCUMENTS_PER_BATCH,
    MAX_REQUEST_BATCH_BYTES,
    MAX_REQUEST_DOCUMENT_BYTES,
    toBatches,
} from "./documents";
import { listArchiveEntries, notionDocuments, stripNotionIds } from "./notion-export";

const fakeFile = (webkitRelativePath: string, content: string | Uint8Array, type = "") => {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;

    return {
        arrayBuffer: async () => new Uint8Array(bytes).buffer as ArrayBuffer,
        name: webkitRelativePath.split("/").at(-1)!,
        size: bytes.byteLength,
        type,
        webkitRelativePath,
    };
};

describe(collectFolderDocuments, () => {
    it("keeps supported files with their folder-relative path and reports the rest", () => {
        const { accepted, skipped } = collectFolderDocuments([
            fakeFile("handbook/intro.md", "# Hi"),
            fakeFile("handbook/policies/leave.pdf", new Uint8Array([1, 2, 3])),
            fakeFile("handbook/logo.png", new Uint8Array([1])),
            fakeFile("handbook/.DS_Store", "x"),
            fakeFile("handbook/__MACOSX/intro.md", "x"),
        ]);

        expect(accepted.map((document) => [document.relativePath, document.mimeType])).toEqual([
            ["handbook/intro.md", "text/markdown"],
            ["handbook/policies/leave.pdf", "application/pdf"],
        ]);
        expect(skipped).toEqual([{ path: "handbook/logo.png", reason: "unsupported" }]);
    });

    it("skips files over the per-document cap", () => {
        const big = { ...fakeFile("f/big.txt", "x"), size: MAX_DOCUMENT_BYTES + 1 };

        expect(collectFolderDocuments([big]).skipped).toEqual([{ path: "f/big.txt", reason: "too-large" }]);
    });
});

describe(encodeDocument, () => {
    it("sends text as UTF-8 and binaries as base64", async () => {
        const [text, pdf] = collectFolderDocuments([fakeFile("a/ü.md", "Grüße"), fakeFile("a/b.pdf", new Uint8Array([104, 105]))]).accepted;

        await expect(encodeDocument(text!)).resolves.toMatchObject({ content: "Grüße", encoding: "utf8", name: "ü.md", relativePath: "a/ü.md" });
        await expect(encodeDocument(pdf!)).resolves.toMatchObject({ content: "aGk=", encoding: "base64", mimeType: "application/pdf" });
    });
});

describe(toBatches, () => {
    it("splits by count and by size, keeping order", () => {
        const small = Array.from({ length: MAX_DOCUMENTS_PER_BATCH + 1 }, (_, index) => {
            return { content: String(index) };
        });

        expect(toBatches(small).batches.map((batch) => batch.length)).toEqual([MAX_DOCUMENTS_PER_BATCH, 1]);

        // Each document is about half the budget as JSON, so two cannot share a call.
        const half = { content: "x".repeat(Math.floor(MAX_REQUEST_BATCH_BYTES / 2)) };

        expect(toBatches([half, half, { content: "y" }]).batches.map((batch) => batch.length)).toEqual([1, 2]);
    });

    it("sends a document over the batch budget alone, in its place in the order", () => {
        // Over the batch budget as JSON, under the single-document limit: it cannot share a call, but it can go by itself.
        const large = { content: "x".repeat(MAX_REQUEST_BATCH_BYTES) };
        const { batches, oversize } = toBatches([{ content: "a" }, large, { content: "b" }]);

        expect(oversize).toEqual([]);
        expect(batches).toEqual([[{ content: "a" }], [large], [{ content: "b" }]]);
    });

    it("sets aside a document over the single-document limit, keeping the rest", () => {
        const huge = { content: "x".repeat(MAX_REQUEST_DOCUMENT_BYTES) };
        const { batches, oversize } = toBatches([{ content: "a" }, huge, { content: "b" }]);

        expect(oversize).toEqual([huge]);
        expect(batches).toEqual([[{ content: "a" }, { content: "b" }]]);
    });
});

describe(documentMimeType, () => {
    it("trusts the extension over the browser's type", () => {
        expect(documentMimeType("notes.MD", "")).toBe("text/markdown");
        expect(documentMimeType("data.bin", "text/plain")).toBe("text/plain");
        expect(documentMimeType("image.png", "image/png")).toBeUndefined();
    });
});

describe("Notion export", () => {
    const zipOf = async (files: Record<string, Uint8Array | string>): Promise<ArrayBuffer> => {
        const zip = new JSZip();

        for (const [path, content] of Object.entries(files)) {
            zip.file(path, content);
        }

        return await zip.generateAsync({ type: "arraybuffer" });
    };

    it("strips Notion's page ids from names and folders", () => {
        expect(stripNotionIds("Export/Roadmap 0123456789abcdef0123456789abcdef/Q3 fedcba9876543210fedcba9876543210.md")).toBe("Export/Roadmap/Q3.md");
    });

    it("turns pages into documents, drops the shared root, attachments and the partial database view", async () => {
        const id = "0123456789abcdef0123456789abcdef";
        const data = await zipOf({
            [`Export-x/Team ${id}.md`]: "# Team",
            [`Export-x/Team ${id}/Onboarding ${id}.md`]: "Welcome",
            [`Export-x/Team ${id}/diagram.png`]: new Uint8Array([1, 2]),
            [`Export-x/Tasks ${id}.csv`]: "a,b",
            [`Export-x/Tasks ${id}_all.csv`]: "a,b\n1,2",
        });
        const { documents, skipped, truncated } = notionDocuments(await listArchiveEntries(data, loadJsZip));

        expect(documents.map((document) => [document.relativePath, document.name, document.mimeType])).toEqual([
            ["Team.md", "Team.md", "text/markdown"],
            ["Team/Onboarding.md", "Onboarding.md", "text/markdown"],
            ["Tasks.csv", "Tasks.csv", "text/csv"],
        ]);
        expect(new TextDecoder().decode(await documents[2]!.read())).toBe("a,b\n1,2");
        expect(skipped).toBe(1);
        expect(truncated).toBe(false);
    });

    it("unpacks a zip of zips one level deep and skips the HTML table of contents", async () => {
        const inner = await zipOf({ "index.html": "<p>toc</p>", "Page 0123456789abcdef0123456789abcdef.html": "<p>Body</p>" });
        const outer = await zipOf({ "Export-Part-1.zip": new Uint8Array(inner) });
        const { documents } = notionDocuments(await listArchiveEntries(outer, loadJsZip));

        expect(documents.map((document) => [document.relativePath, document.mimeType])).toEqual([["Page.html", "text/html"]]);
    });
});
