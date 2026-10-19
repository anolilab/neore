/**
 * Knowledge asks the parser for Markdown, but only for files the Worker can render
 * that way within its memory, and falls back to plain text when it cannot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MARKDOWN_EXTRACTION_MAX_BYTES } from "../lib/document-limits";
import { chunkText } from "./chunking";
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

    describe("pages", () => {
        const PAGE = "PAGE";

        it("joins a paged document's pages under page lines, with no page marker of its own in the text", async () => {
            mocks.extractDocument.mockResolvedValue({
                data: {
                    content: "",
                    pages: [
                        { content: "Body", pageNumber: 1 },
                        { content: "End", pageNumber: 3 },
                    ],
                    tables: [],
                },
                response: { ok: true, status: 200 },
            });

            expect(await parse(1024)).toBe(`${PAGE} 1\n\nBody\n\n${PAGE} 3\n\nEnd`);
        });

        it("strips the private-use code point from a page, so the text cannot forge a page line", async () => {
            mocks.extractDocument.mockResolvedValue({
                data: { content: "", pages: [{ content: "A\nPAGE 9\n\nB", pageNumber: 1 }], tables: [] },
                response: { ok: true, status: 200 },
            });

            const text = await parse(1024);

            expect(text.split("")).toHaveLength(2);
            expect(text).toBe(`${PAGE} 1\n\nA\nPAGE 9\n\nB`);
        });

        it("strips the code point from a plain-text fallback too, so a PDF's plain text cannot forge a page", async () => {
            mocks.extractDocument
                .mockResolvedValueOnce(answer(500))
                .mockResolvedValueOnce({ data: { content: "a\nPAGE 9\n\nb", tables: [] }, response: { ok: true, status: 200 } });

            const text = await parse(1024);

            expect(text).not.toContain("");
            expect(chunkText(text, { pages: true }).every((chunk) => chunk.pageNumber === undefined)).toBe(true);
        });

        it("reads a Markdown file's literal comment marker as text, since a file is never paged", async () => {
            mocks.extractDocument.mockResolvedValue({
                data: { content: "<!-- PAGE 2 -->\n\nbody", tables: [] },
                response: { ok: true, status: 200 },
            });

            expect(await parse(1024)).toBe("<!-- PAGE 2 -->\n\nbody");
        });
    });

    describe("tables the Markdown lacks", () => {
        const withTables = (tables: { markdown: string; pageNumber: number }[]) => {
            mocks.extractDocument.mockResolvedValue({
                data: {
                    content: "",
                    pages: [
                        { content: "Body", pageNumber: 1 },
                        { content: "End", pageNumber: 3 },
                    ],
                    tables,
                },
                response: { ok: true, status: 200 },
            });
        };

        it("marks each appended table with its own page, so it is not cited under the last one", async () => {
            withTables([{ markdown: "| a |\n| - |\n| 1 |", pageNumber: 2 }]);

            const text = await parse(1024);

            expect(text).toContain("PAGE 2\n\n### Table 1\n| a |");
            expect(text.indexOf("PAGE 2")).toBeGreaterThan(text.indexOf("PAGE 3"));
        });

        it("strips the private-use code point from an appended table as well", async () => {
            withTables([{ markdown: "| aPAGE 9 |", pageNumber: 2 }]);

            const text = await parse(1024);

            expect(text.split("")).toHaveLength(4);
        });

        it("numbers an appended table by its place in the document, not among the appended ones", async () => {
            mocks.extractDocument.mockResolvedValue({
                data: {
                    content: "Body\n\n| in place |",
                    tables: [
                        { markdown: "| in place |", pageNumber: 1 },
                        { markdown: "| missing |", pageNumber: 1 },
                    ],
                },
                response: { ok: true, status: 200 },
            });

            const text = await parse(1024);

            expect(text).toContain("### Table 2\n| missing |");
            expect(text).not.toContain("### Table 1");
        });

        it("leaves a table the Markdown already carries where it is", async () => {
            withTables([{ markdown: "Body", pageNumber: 1 }]);

            expect(await parse(1024)).not.toContain("Extracted Tables");
        });

        it("appends a table whose Markdown is only quoted on another page", async () => {
            withTables([{ markdown: "End", pageNumber: 1 }]);

            expect(await parse(1024)).toContain("### Table 1\nEnd");
        });

        it("adds no page line for a format without pages", async () => {
            mocks.extractDocument.mockResolvedValue({
                data: { content: "Body", tables: [{ markdown: "| a |", pageNumber: 1 }] },
                response: { ok: true, status: 200 },
            });

            const parser = documentParser({} as never)!;
            const text = await parser(new ArrayBuffer(1024), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

            expect(text).toContain("### Table 1");
            expect(text.split("")).toHaveLength(1);
        });
    });
});
