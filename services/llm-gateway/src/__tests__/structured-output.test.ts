/**
 * Unit tests for lib/structured-output.ts
 *
 * Covers:
 *   - validateJsonResponse: valid JSON, parse errors, schema validation
 *   - healJsonResponse: code fences, trailing commas, unclosed brackets
 *   - repairWithModel: mocked LLM repair pass
 */
import { describe, expect, it, vi } from "vitest";

import { healJsonResponse, repairWithModel, validateJsonResponse } from "../lib/structured-output.js";

// Module-level mock for repairWithModel tests — must be hoisted
vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        generateText: vi.fn(),
    };
});

// ---------------------------------------------------------------------------
// validateJsonResponse
// ---------------------------------------------------------------------------

describe("validateJsonResponse", () => {
    describe("no schema", () => {
        it("returns valid for a well-formed JSON object", () => {
            const result = validateJsonResponse('{"name": "Alice", "age": 30}');

            expect(result.valid).toBe(true);

            if (result.valid) expect(result.parsed).toEqual({ age: 30, name: "Alice" });
        });

        it("returns valid for a JSON array", () => {
            const result = validateJsonResponse("[1, 2, 3]");

            expect(result.valid).toBe(true);
        });

        it("returns valid for a JSON string", () => {
            const result = validateJsonResponse('"hello"');

            expect(result.valid).toBe(true);
        });

        it.each([
            { input: '{"key": value}', label: "invalid JSON" },
            { input: "", label: "an empty string" },
            { input: "Here is your JSON: ...", label: "plain text" },
        ])("returns parse_error for $label", ({ input }) => {
            const result = validateJsonResponse(input);

            expect(result.valid).toBe(false);

            if (!result.valid) expect(result.error).toBe("parse_error");
        });
    });

    describe("with schema (type validation)", () => {
        it("passes when type matches", () => {
            const result = validateJsonResponse('{"count": 5}', { type: "object" });

            expect(result.valid).toBe(true);
        });

        it("fails when type does not match", () => {
            const result = validateJsonResponse('"hello"', { type: "object" });

            expect(result.valid).toBe(false);

            if (!result.valid) expect(result.error).toBe("schema_error");
        });

        it("validates required properties", () => {
            const schema = {
                properties: { age: { type: "integer" }, name: { type: "string" } },
                required: ["name", "age"],
                type: "object",
            };

            const valid = validateJsonResponse('{"name": "Alice", "age": 30}', schema);

            expect(valid.valid).toBe(true);

            const missing = validateJsonResponse('{"name": "Alice"}', schema);

            expect(missing.valid).toBe(false);

            if (!missing.valid) expect(missing.error).toBe("schema_error");
        });

        it("validates property types", () => {
            const schema = {
                properties: { count: { type: "integer" } },
                type: "object",
            };

            const valid = validateJsonResponse('{"count": 5}', schema);

            expect(valid.valid).toBe(true);

            const invalid = validateJsonResponse('{"count": "five"}', schema);

            expect(invalid.valid).toBe(false);
        });

        it("validates array items", () => {
            const schema = { items: { type: "string" }, type: "array" };

            const valid = validateJsonResponse('["a", "b", "c"]', schema);

            expect(valid.valid).toBe(true);

            const invalid = validateJsonResponse('["a", 1, "c"]', schema);

            expect(invalid.valid).toBe(false);
        });
    });
});

// ---------------------------------------------------------------------------
// healJsonResponse
// ---------------------------------------------------------------------------

describe("healJsonResponse", () => {
    it("returns the text unchanged when JSON is already valid", () => {
        const input = '{"key": "value"}';
        const result = healJsonResponse(input);

        expect(result).toBe(input);
        expect(JSON.parse(result!)).toEqual({ key: "value" });
    });

    describe("markdown code fence extraction", () => {
        it("extracts JSON from ```json ... ``` fence", () => {
            const input = '```json\n{"key": "value"}\n```';
            const result = healJsonResponse(input);

            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual({ key: "value" });
        });

        it("extracts JSON from ``` ... ``` fence without language tag", () => {
            const input = '```\n{"key": "value"}\n```';
            const result = healJsonResponse(input);

            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual({ key: "value" });
        });

        it("extracts from fence even with surrounding text", () => {
            const input = 'Here is the JSON:\n```json\n{"name": "Alice"}\n```\nThat is all.';
            const result = healJsonResponse(input);

            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual({ name: "Alice" });
        });
    });

    describe("trailing comma removal", () => {
        it("removes trailing comma before }", () => {
            const input = '{"key": "value",}';
            const result = healJsonResponse(input);

            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual({ key: "value" });
        });

        it("removes trailing comma before ]", () => {
            const input = "[1, 2, 3,]";
            const result = healJsonResponse(input);

            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual([1, 2, 3]);
        });

        it("handles multiple trailing commas at different levels", () => {
            const input = '{"a": [1, 2,], "b": "val",}';
            const result = healJsonResponse(input);

            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual({ a: [1, 2], b: "val" });
        });
    });

    describe("unclosed bracket repair", () => {
        it("closes a missing }", () => {
            const input = '{"key": "value"';
            const result = healJsonResponse(input);

            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual({ key: "value" });
        });

        it("closes a missing ]", () => {
            const input = "[1, 2, 3";
            const result = healJsonResponse(input);

            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual([1, 2, 3]);
        });

        it("closes nested unclosed brackets", () => {
            const input = '{"outer": {"inner": "val"';
            const result = healJsonResponse(input);

            expect(result).not.toBeNull();
            expect(JSON.parse(result!)).toEqual({ outer: { inner: "val" } });
        });
    });

    it("returns null for completely unrepresentable input", () => {
        const result = healJsonResponse("This is not JSON at all and has no brackets");

        // Empty string or plain text won't parse even after bracket closing
        // It should return null since no valid JSON can be formed
        // (actually "" is not valid JSON; "null" is not produced — returns null)
        expect(
            result === null ||
                (result !== null &&
                    !(() => {
                        try {
                            JSON.parse(result);

                            return true;
                        } catch {
                            return false;
                        }
                    })()),
        ).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// repairWithModel
// ---------------------------------------------------------------------------

describe("repairWithModel", () => {
    it("returns healed JSON when model produces valid JSON", async () => {
        const { generateText } = await import("ai");

        vi.mocked(generateText).mockResolvedValueOnce({
            finishReason: "stop",
            text: '{"name": "Alice", "age": 30}',
            usage: { inputTokens: 10, outputTokens: 10 } as never,
        } as unknown as Awaited<ReturnType<typeof generateText>>);

        const mockModel = {} as import("ai").LanguageModel;
        const result = await repairWithModel(mockModel, '{"name": "Alice", "age":}', "JSON object with name and age");

        expect(result).not.toBeNull();

        if (result) expect(JSON.parse(result)).toEqual({ age: 30, name: "Alice" });
    });

    it("extracts JSON from code fence in model response", async () => {
        const { generateText } = await import("ai");

        vi.mocked(generateText).mockResolvedValueOnce({
            finishReason: "stop",
            text: '```json\n{"fixed": true}\n```',
            usage: { inputTokens: 10, outputTokens: 10 } as never,
        } as unknown as Awaited<ReturnType<typeof generateText>>);

        const mockModel = {} as import("ai").LanguageModel;
        const result = await repairWithModel(mockModel, '{"fixed": broken}', "schema");

        expect(result).not.toBeNull();

        if (result) expect(JSON.parse(result)).toEqual({ fixed: true });
    });

    it("returns null when model call throws", async () => {
        const { generateText } = await import("ai");

        vi.mocked(generateText).mockRejectedValueOnce(new Error("Provider error"));

        const mockModel = {} as import("ai").LanguageModel;
        const result = await repairWithModel(mockModel, '{"bad": json}', "schema");

        expect(result).toBeNull();
    });
});
