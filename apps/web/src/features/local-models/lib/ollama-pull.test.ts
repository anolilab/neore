import { describe, expect, it } from "vitest";

import { createLineSplitter, formatBytes, isValidOllamaModelName, parsePullProgress } from "./ollama-pull";

describe(parsePullProgress, () => {
    it("reads a status-only line", () => {
        expect.assertions(1);
        expect(parsePullProgress('{"status":"pulling manifest"}')).toStrictEqual({ done: false, status: "pulling manifest" });
    });

    it("computes the current layer's percentage", () => {
        expect.assertions(1);
        expect(parsePullProgress('{"status":"pulling 6a0746a1ec1a","digest":"sha256:6a07","total":2000,"completed":500}')).toStrictEqual({
            completed: 500,
            digest: "sha256:6a07",
            done: false,
            percent: 25,
            status: "pulling 6a0746a1ec1a",
            total: 2000,
        });
    });

    it("treats a sized layer with no completed bytes yet as 0%", () => {
        expect.assertions(1);
        expect(parsePullProgress('{"status":"pulling a","total":10}')).toMatchObject({ completed: 0, percent: 0 });
    });

    it("clamps to 100 and flags success as done", () => {
        expect.assertions(2);
        expect(parsePullProgress('{"status":"pulling a","total":10,"completed":11}')?.percent).toBe(100);
        expect(parsePullProgress('{"status":"success"}')).toStrictEqual({ done: true, status: "success" });
    });

    it("surfaces an error line", () => {
        expect.assertions(1);
        expect(parsePullProgress('{"error":"pull model manifest: file does not exist"}')).toStrictEqual({
            done: true,
            error: "pull model manifest: file does not exist",
            status: "error",
        });
    });

    it("skips lines that are not JSON objects", () => {
        expect.assertions(2);
        expect(parsePullProgress("garbage")).toBeUndefined();
        expect(parsePullProgress("42")).toBeUndefined();
    });
});

describe(createLineSplitter, () => {
    it("reassembles lines split across chunks and flushes the tail", () => {
        expect.assertions(3);

        const splitter = createLineSplitter();

        expect(splitter.feed('{"status":"a"}\n{"sta')).toStrictEqual(['{"status":"a"}']);
        expect(splitter.feed('tus":"b"}\n\n{"status":"c"}')).toStrictEqual(['{"status":"b"}']);
        expect(splitter.flush()).toStrictEqual(['{"status":"c"}']);
    });
});

describe(isValidOllamaModelName, () => {
    it.each(["llama3.2", "llama3.2:3b", "qwen2.5-coder:7b-instruct-q4_K_M", "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M", "library/mistral"])(
        "accepts %s",
        (name) => {
            expect.assertions(1);
            expect(isValidOllamaModelName(name)).toBe(true);
        },
    );

    it.each(["", "llama 3", "https://evil.example/model", "a:b:c", "x".repeat(201)])("refuses %j", (name) => {
        expect.assertions(1);
        expect(isValidOllamaModelName(name)).toBe(false);
    });
});

describe(formatBytes, () => {
    it("uses binary units like the Ollama CLI", () => {
        expect.assertions(4);
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(2_019_377_376)).toBe("1.9 GB");
        expect(formatBytes(42 * 1024 ** 3)).toBe("42 GB");
    });
});
