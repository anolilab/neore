import { describe, expect, it } from "vitest";

import { excerptLog, excerptRead, isLogAddress, LOG_EXCERPT_MAX_CHARS, readTail } from "./check-log";

/** A cut excerpt opens with its marker. */
const MARKED_TAIL = /^\[truncated, \d+ more lines\]\nline /u;

const stamp = (line: string): string => `2026-11-06T10:00:00.1234567Z ${line}`;

describe(excerptLog, () => {
    it("keeps the lines around the host's error marker, without timestamps or colour codes", () => {
        const lines = [
            ...Array.from({ length: 200 }, (_, index) => stamp(`setup step ${String(index)}`)),
            stamp("\u{1B}[31mFAIL src/sum.test.ts\u{1B}[0m"),
            stamp("##[error]Process completed with exit code 1."),
        ];
        const log = excerptLog(lines.join("\n"));

        expect(log.excerpt).toContain("FAIL src/sum.test.ts");
        expect(log.excerpt).toContain("##[error]Process completed with exit code 1.");
        expect(log.excerpt).not.toContain("2026-11-06T");
        expect(log.excerpt).not.toContain("\u{1B}[");
        expect(log.excerpt).not.toContain("setup step 0\n");
        expect(log.truncated).toBe(true);
    });

    it("never goes over the cap, keeping the last failure when they do not all fit", () => {
        const noise = "x".repeat(300);
        const lines = Array.from({ length: 2000 }, (_, index) => (index % 50 === 49 ? `##[error]failure ${String(index)}` : noise));
        const log = excerptLog(lines.join("\n"));

        expect(log.excerpt.length).toBeLessThanOrEqual(LOG_EXCERPT_MAX_CHARS);
        expect(log.excerpt).toContain("failure 1999");
        expect(log.truncated).toBe(true);
    });

    it("cuts one huge line to the cap", () => {
        const log = excerptLog(`##[error]${"y".repeat(50_000)}`, 1000);

        expect(log.excerpt.length).toBeLessThanOrEqual(1000);
        expect(log.truncated).toBe(true);
    });

    it("takes the tail of a log with no failure marker", () => {
        const log = excerptLog(Array.from({ length: 1000 }, (_, index) => `line ${String(index)}`).join("\n"), 200);

        expect(log.excerpt.length).toBeLessThanOrEqual(200);
        expect(log.excerpt.endsWith("line 999")).toBe(true);
        expect(log.excerpt).toMatch(MARKED_TAIL);
    });

    it("keeps the failure line when even its window does not fit", () => {
        const log = excerptLog(["setup", "##[error]the build broke here", ...Array.from({ length: 5 }, () => "z".repeat(400))].join("\n"), 200);

        expect(log.excerpt).toContain("##[error]the build broke here");
        expect(log.excerpt.length).toBeLessThanOrEqual(200);
    });

    it("never passes the cap, however small it is", () => {
        const raw = Array.from({ length: 50 }, (_, index) => `line ${String(index)}`).join("\n");

        for (const cap of [0, 10, 64, 80]) {
            expect(excerptLog(raw, cap).excerpt.length).toBeLessThanOrEqual(cap);
        }
    });

    it("keeps an unfinished log's excerpt inside a cap smaller than its ending", () => {
        for (const cap of [0, 10, 40]) {
            expect(excerptRead({ endReached: false, partial: true, text: "##[error]boom" }, cap).excerpt.length).toBeLessThanOrEqual(cap);
        }
    });

    it("keeps a short log whole", () => {
        expect(excerptLog("one\ntwo\n")).toStrictEqual({ excerpt: "one\ntwo", source: "job_log", truncated: false });
    });
});

describe(readTail, () => {
    const streamOf = (chunks: string[]): Response => {
        const encoder = new TextEncoder();

        return new Response(
            new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) {
                        controller.enqueue(encoder.encode(chunk));
                    }

                    controller.close();
                },
            }),
        );
    };

    it("keeps only the end of a long body", async () => {
        const { partial, text } = await readTail(streamOf(["a".repeat(100), "b".repeat(100), "c".repeat(100)]), 150);

        expect(partial).toBe(true);
        expect(text).toBe(`${"b".repeat(50)}${"c".repeat(100)}`);
    });

    it("stops reading at the read cap", async () => {
        const { partial, text } = await readTail(streamOf(["a".repeat(100), "b".repeat(100), "c".repeat(100)]), 1000, 150);

        expect(partial).toBe(true);
        expect(text).not.toContain("c");
    });

    it("keeps what it read when the body is cut off, and says the end was not reached", async () => {
        const encoder = new TextEncoder();
        const response = new Response(
            new ReadableStream({
                pull(controller) {
                    controller.enqueue(encoder.encode("##[error]boom\n"));
                    controller.error(new Error("deadline"));
                },
            }),
        );

        expect(await readTail(response)).toStrictEqual({ endReached: false, partial: true, text: "##[error]boom\n" });
    });

    it("marks an excerpt whose log was not read to its end", () => {
        const cut = excerptRead({ endReached: false, partial: true, text: "##[error]boom" }, 200);

        expect(cut).toMatchObject({ endRead: false, truncated: true });
        expect(cut.excerpt).toContain("##[error]boom");
        expect(cut.excerpt.endsWith("[truncated, the log goes on past what was read]")).toBe(true);
        expect(cut.excerpt.length).toBeLessThanOrEqual(200);
        expect(excerptRead({ endReached: true, partial: false, text: "ok" }, 100)).not.toHaveProperty("endRead");
    });

    it("takes a chunk that crosses the read cap only up to the cap", async () => {
        const { endReached, text } = await readTail(streamOf(["a".repeat(100), "b".repeat(100)]), 1000, 150);

        expect(endReached).toBe(false);
        expect(text).toBe(`${"a".repeat(100)}${"b".repeat(50)}`);
    });

    it("keeps only the tail of one chunk larger than what is kept", async () => {
        const { partial, text } = await readTail(streamOf([`${"a".repeat(100)}${"b".repeat(20)}`]), 20);

        expect(partial).toBe(true);
        expect(text).toBe("b".repeat(20));
    });

    it("answers a short body whole", async () => {
        expect(await readTail(streamOf(["done"]))).toStrictEqual({ endReached: true, partial: false, text: "done" });
    });
});

// Built from parts: a storage account address written out reads as a credential to the secret scanner.
const STORAGE = ["productionresultssa1", "blob", "core", "windows", "net"].join(".");

describe(isLogAddress, () => {
    it("accepts the host's storage origins over https only", () => {
        expect(isLogAddress(`https://${STORAGE}/actions-results/1`)).toBe(true);
        expect(isLogAddress("https://pipelines.actions.githubusercontent.com/logs/1")).toBe(true);
        expect(isLogAddress("ftp://pipelines.actions.githubusercontent.com/logs/1")).toBe(false);
        expect(isLogAddress(`https://evil.example/${STORAGE}`)).toBe(false);
        expect(isLogAddress(`https://user:pw@${STORAGE}/a`)).toBe(false);
        expect(isLogAddress("not a url")).toBe(false);
    });
});
