/**
 * Structured output validation and response healing.
 *
 * When a client requests `response_format: json_object | json_schema`, the
 * gateway validates the provider response and attempts repair before returning
 * an error to the client. Three-tier healing:
 *
 *   1. `validateJsonResponse` — parse + optional schema check
 *   2. `healJsonResponse`     — heuristic repair (code fences, trailing commas, brackets)
 *   3. `repairWithModel`      — single-pass model-based repair at temperature 0.1
 */
import type { JSONValue } from "@ai-sdk/provider";
import { generateText } from "ai";

/** The JSON Schema subset {@link checkSchema} understands. */
export type JSONSchema = {
    items?: JSONSchema;
    properties?: Record<string, JSONSchema>;
    required?: string[];
    type?: string;
};

export type ValidationResult = { parsed: unknown; valid: true } | { details?: string; error: "parse_error" | "schema_error"; rawText: string; valid: false };

/**
 * Parse and optionally validate a JSON string against a schema.
 *
 * Schema validation is lightweight — supports `type`, `properties`, `required`,
 * and `items`. Sufficient for gateway-level validation without pulling in ajv.
 */
export const validateJsonResponse = (text: string, schema?: JSONSchema): ValidationResult => {
    // Step 1: Parse
    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch {
        return { error: "parse_error", rawText: text, valid: false };
    }

    // Step 2: Schema check (if schema provided)
    if (schema) {
        const violation = checkSchema(parsed, schema, "$");

        if (violation) {
            return { details: violation, error: "schema_error", rawText: text, valid: false };
        }
    }

    return { parsed, valid: true };
};

const WHITESPACE_RE = /\s/;

/**
 * Content between the first ``` fence and the next one, or `undefined`.
 *
 * An optional `json` tag and any whitespace after the opening fence are skipped.
 */
const extractCodeFence = (text: string): string | undefined => {
    const open = text.indexOf("```");

    if (open === -1) {
        return undefined;
    }

    let start = open + 3;

    if (text.startsWith("json", start)) {
        start += 4;
    }

    while (start < text.length && WHITESPACE_RE.test(text[start] ?? "")) {
        start += 1;
    }

    const close = text.indexOf("```", start);

    return close === -1 ? undefined : text.slice(start, close);
};

/**
 * Attempt to repair a malformed JSON string using heuristics:
 *
 *   1. Extract JSON from markdown code fences (```json ... ```)
 *   2. Remove trailing commas before } or ]
 *   3. Close unclosed brackets/braces
 *
 * Returns the healed string if successful, or `null` if the string cannot be repaired.
 */
export const healJsonResponse = (rawText: string): string | null => {
    let text = rawText.trim();

    // 1. Extract from markdown code fence: ```json ... ``` or ``` ... ```
    //
    // By index, not by regex. ```` /```(?:json)?\s*([\s\S]*?)```/ ```` has `\s*`
    // next to a lazy `[\s\S]*?`, which backtrack against each other — this runs
    // on raw model output, and 40k characters of padding took 189ms.
    const fenced = extractCodeFence(text);

    if (fenced !== undefined) {
        text = fenced.trim();
    }

    // Try parsing after code fence extraction
    if (isParseable(text)) return text;

    // 2. Remove trailing commas (before } or ])
    text = text.replaceAll(/,\s*([}\]])/g, "$1");

    if (isParseable(text)) return text;

    // 3. Close unclosed brackets/braces
    const closed = closeOpenBrackets(text);

    if (closed !== null && isParseable(closed)) return closed;

    return null;
};

/**
 * Call the LLM to repair a malformed JSON response.
 *
 * Sends a single low-temperature repair prompt. Returns the repaired JSON
 * string on success, or `null` if the repair call fails or produces invalid JSON.
 *
 * Only called when `healJsonResponse` cannot repair the text heuristically.
 */
export const repairWithModel = async (model: import("ai").LanguageModel, brokenResponse: string, schemaDescription: string): Promise<string | null> => {
    const prompt = `The following JSON response was malformed. Fix it to match the schema. Return ONLY valid JSON, nothing else.

Schema description: ${schemaDescription}

Malformed response:
${brokenResponse}`;

    try {
        const result = await generateText({
            maxOutputTokens: 4096,
            messages: [{ content: prompt, role: "user" }],
            model,
            temperature: 0.1,
        });

        const healed = healJsonResponse(result.text) ?? result.text.trim();

        if (isParseable(healed)) return healed;

        return null;
    } catch {
        return null;
    }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isParseable = (text: string): boolean => {
    try {
        JSON.parse(text);

        return true;
    } catch {
        return false;
    }
};

/**
 * Attempt to close unclosed brackets and braces.
 * Handles basic cases like `{"key": "val"` → `{"key": "val"}`.
 */
const closeOpenBrackets = (text: string): string | null => {
    const stack: string[] = [];
    let isInString = false;
    let isEscape = false;

    for (const char of text) {
        if (isEscape) {
            isEscape = false;
            continue;
        }

        if (char === "\\") {
            isEscape = true;
            continue;
        }

        if (char === '"') {
            isInString = !isInString;
            continue;
        }

        if (isInString) continue;

        switch (char) {
            case "[": {
                stack.push("]");
                break;
            }
            case "]":
            case "}": {
                if (stack[stack.length - 1] === char) {
                    stack.pop();
                } else {
                    return null; // Mismatched bracket
                }

                break;
            }
            case "{": {
                stack.push("}");
                break;
            }
            default: {
                break;
            }
        }
    }

    if (isInString) {
        // Close the open string first
        return `${text}"${stack.toReversed().join("")}`;
    }

    return text + stack.toReversed().join("");
};

/**
 * Lightweight recursive JSON Schema validator.
 * Returns a violation message string on failure, or null on success.
 */
const checkSchema = (value: unknown, schema: JSONSchema, path: string): string | null => {
    const { type } = schema;

    if (type) {
        const actualType = getJsonType(value);

        if (actualType !== type) {
            return `${path}: expected type "${type}", got "${actualType}"`;
        }
    }

    // Object schema: check properties and required
    if (typeof value === "object" && value !== null && !Array.isArray(value) && schema["properties"]) {
        const { properties, required = [] } = schema;
        // `value` reached us from `JSON.parse`, so its members are JSON.
        const object = value as Record<string, JSONValue>;

        for (const key of required) {
            if (!Object.hasOwn(object, key)) {
                return `${path}: missing required property "${key}"`;
            }
        }

        for (const [key, propSchema] of Object.entries(properties)) {
            if (!Object.hasOwn(object, key)) {
                continue;
            }

            const violation = checkSchema(object[key], propSchema, `${path}.${key}`);

            if (violation) return violation;
        }
    }

    // Array schema: check items
    if (schema["items"] && Array.isArray(value)) {
        const itemSchema = schema.items;

        for (const [i, element] of value.entries()) {
            const violation = checkSchema(element, itemSchema, `${path}[${i}]`);

            if (violation) return violation;
        }
    }

    return null;
};

const getJsonType = (value: unknown): string => {
    if (value === null) return "null";

    if (Array.isArray(value)) return "array";

    // JSON Schema's `integer` is a mathematical predicate, so large exact
    // integers past MAX_SAFE_INTEGER still count.
    if (typeof value === "number") {
        const truncated = Math.trunc(value);

        return truncated === value ? "integer" : "number";
    }

    return typeof value;
};
