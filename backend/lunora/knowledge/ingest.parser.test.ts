/**
 * Knowledge asks the parser for Markdown, but only for files the Worker can render
 * that way within its memory, and falls back to plain text when it cannot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MARKDOWN_EXTRACTION_MAX_BYTES } from "../lib/document-limits";
import { documentParser } from "./ingest";

const mocks = vi.hoisted(() => {
    return { extractDocument: vi.fn() };
});

vi.mock("@neore/service-sdk/document-parser", () => {
    return {
        createDocumentParserClient: () => {
            return {};
        },
        extractDocument: mocks.extractDocument,
    };
});
vi.mock("../lib/services", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/services")>()), isServiceBound: () => true, serviceFetch: () => vi.fn() };
});

const answer = (status: number, content = "text") => {
    return {
        data: status === 200 ? { content, tables: [] } : undefined,
        error: status === 200 ? undefined : { error: "x" },
        response: { ok: status === 200, status },
    };
};

const parse = async (size: number) => {
    const parser = documentParser({} as never)!;

    return await parser(new ArrayBuffer(size), "application/pdf");
};

const queryOf = (call: number) => (mocks.extractDocument.mock.calls[call]?.[0] as { query?: unknown }).query;

beforeEach(() => {
    mocks.extractDocument.mockReset();
});

describe("documentParser", () => {
    it("asks for Markdown for a file within the size gate", async () => {
        mocks.extractDocument.mockResolvedValue(answer(200, "# Heading"));

        expect(await parse(MARKDOWN_EXTRACTION_MAX_BYTES)).toBe("# Heading");
        expect(mocks.extractDocument).toHaveBeenCalledOnce();
        expect(queryOf(0)).toEqual({ format: "markdown" });
    });

    it("asks for plain text for a file over the gate", async () => {
        mocks.extractDocument.mockResolvedValue(answer(200));

        await parse(MARKDOWN_EXTRACTION_MAX_BYTES + 1);

        expect(mocks.extractDocument).toHaveBeenCalledOnce();
        expect(queryOf(0)).toBeUndefined();
    });

    it("retries as plain text when the Markdown render fails with a 5xx", async () => {
        mocks.extractDocument.mockResolvedValueOnce(answer(500)).mockResolvedValueOnce(answer(200, "plain"));

        expect(await parse(1024)).toBe("plain");
        expect(queryOf(0)).toEqual({ format: "markdown" });
        expect(queryOf(1)).toBeUndefined();
    });

    it("retries as plain text when the Markdown render rejects, as a Worker out of memory does", async () => {
        mocks.extractDocument.mockRejectedValueOnce(new Error("Worker exceeded memory")).mockResolvedValueOnce(answer(200, "plain"));

        expect(await parse(1024)).toBe("plain");
        expect(mocks.extractDocument).toHaveBeenCalledTimes(2);
        expect(queryOf(0)).toEqual({ format: "markdown" });
        expect(queryOf(1)).toBeUndefined();
    });

    it("lets a rejected plain-text attempt propagate", async () => {
        mocks.extractDocument.mockRejectedValueOnce(new Error("Worker exceeded memory")).mockRejectedValueOnce(new Error("plain failed"));

        await expect(parse(1024)).rejects.toThrow("plain failed");
        expect(mocks.extractDocument).toHaveBeenCalledTimes(2);
    });

    it("lets a rejected plain-text attempt propagate for a file over the gate, which has no Markdown attempt", async () => {
        mocks.extractDocument.mockRejectedValueOnce(new Error("Worker exceeded memory"));

        await expect(parse(MARKDOWN_EXTRACTION_MAX_BYTES + 1)).rejects.toThrow("Worker exceeded memory");
        expect(mocks.extractDocument).toHaveBeenCalledOnce();
    });

    it("does not retry a 4xx, which is a verdict on the file", async () => {
        mocks.extractDocument.mockResolvedValue(answer(422));

        await expect(parse(1024)).rejects.toThrow("Parser returned 422");
        expect(mocks.extractDocument).toHaveBeenCalledOnce();
    });

    it("refuses an over-size document with its own message", async () => {
        mocks.extractDocument.mockResolvedValue(answer(413));

        await expect(parse(1024)).rejects.toThrow("at most");
    });
});
