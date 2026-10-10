import type { I18n, MessageDescriptor } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";

import {
    extractVariables,
    filterVariables,
    formatVariable,
    getAllCommonVariables,
    hasVariables,
    highlightVariables,
    isSystemManagedVariable,
    parseVariableMatch,
    replaceVariables,
    replaceWithDefaults,
    syncVariablesWithContent,
    validateVariables,
} from "./prompt-variables";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

/** Stands in for the component's i18n: marks what went through translation. */
const i18n = { _: (descriptor: MessageDescriptor) => `«${descriptor.id}»` } as unknown as I18n;

describe("extractVariables", () => {
    it("should extract simple variables", () => {
        expect(extractVariables("Hello {{name}}")).toEqual(["name"]);
    });

    it("should extract multiple variables", () => {
        const result = extractVariables("{{greeting}} {{name}}, welcome to {{place}}");

        expect(result).toEqual(["greeting", "name", "place"]);
    });

    it("should extract dotted variables", () => {
        expect(extractVariables("Hi {{user.name}} from {{user.organization}}")).toEqual(["user.name", "user.organization"]);
    });

    it("should deduplicate variables", () => {
        expect(extractVariables("{{name}} and {{name}} again")).toEqual(["name"]);
    });

    it("should return sorted variables", () => {
        expect(extractVariables("{{zebra}} {{alpha}} {{middle}}")).toEqual(["alpha", "middle", "zebra"]);
    });

    it("should return empty array when no variables found", () => {
        expect(extractVariables("No variables here")).toEqual([]);
        expect(extractVariables("")).toEqual([]);
    });
});

describe("hasVariables", () => {
    it("should return true when variables present", () => {
        expect(hasVariables("Hello {{name}}")).toBe(true);
    });

    it("should return false when no variables", () => {
        expect(hasVariables("Hello world")).toBe(false);
        expect(hasVariables("")).toBe(false);
    });
});

describe("replaceVariables", () => {
    it("should replace variables with values", () => {
        const result = replaceVariables("Hello {{name}}, you are {{role}}", {
            name: "Alice",
            role: "admin",
        });

        expect(result).toBe("Hello Alice, you are admin");
    });

    it("should replace unmatched variables with bracketed name by default", () => {
        const result = replaceVariables("Hello {{name}}", {});

        expect(result).toBe("Hello [name]");
    });

    it("should keep unmatched variables when keepUnmatched is true", () => {
        const result = replaceVariables("Hello {{name}}", {}, { keepUnmatched: true });

        expect(result).toBe("Hello {{name}}");
    });

    it("should handle multiple occurrences of same variable", () => {
        const result = replaceVariables("{{x}} and {{x}}", { x: "val" });

        expect(result).toBe("val and val");
    });
});

describe("replaceWithDefaults", () => {
    it("should replace variables with default values", () => {
        const result = replaceWithDefaults("Hello {{name}}", [{ defaultValue: "World", name: "name" }]);

        expect(result).toBe("Hello World");
    });

    it("should keep unmatched variables when no default", () => {
        const result = replaceWithDefaults("Hello {{name}}", [{ name: "name" }]);

        expect(result).toBe("Hello {{name}}");
    });
});

describe("validateVariables", () => {
    it("should pass when all required variables have values", () => {
        const result = validateVariables(
            "{{name}} {{email}}",
            [
                { name: "name", required: true },
                { name: "email", required: true },
            ],
            { email: "a@b.com", name: "Alice" },
        );

        expect(result.valid).toBe(true);
        expect(result.missing).toEqual([]);
    });

    it("should report missing required variables", () => {
        const result = validateVariables(
            "{{name}} {{email}}",
            [
                { name: "name", required: true },
                { name: "email", required: true },
            ],
            { name: "Alice" },
        );

        expect(result.valid).toBe(false);
        expect(result.missing).toEqual(["email"]);
    });

    it("should ignore non-required variables", () => {
        const result = validateVariables("{{name}} {{optional}}", [{ name: "name", required: true }, { name: "optional" }], { name: "Alice" });

        expect(result.valid).toBe(true);
    });

    it("should ignore required variables not used in content", () => {
        const result = validateVariables("Hello world", [{ name: "unused", required: true }], {});

        expect(result.valid).toBe(true);
    });
});

describe("syncVariablesWithContent", () => {
    it("should preserve existing variable definitions", () => {
        const result = syncVariablesWithContent("{{name}}", [{ defaultValue: "Alice", description: "User name", name: "name" }]);

        expect(result).toEqual([{ defaultValue: "Alice", description: "User name", name: "name" }]);
    });

    it("should add new variables from content", () => {
        const result = syncVariablesWithContent("{{name}} {{newVar}}", [{ name: "name" }]);

        expect(result).toHaveLength(2);
        expect(result[1]).toEqual({ name: "newVar" });
    });

    it("should remove variables no longer in content", () => {
        const result = syncVariablesWithContent("{{name}}", [{ name: "name" }, { name: "removed" }]);

        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe("name");
    });
});

describe("parseVariableMatch", () => {
    it("should find open variable at cursor position", () => {
        const result = parseVariableMatch("Hello {{na", 10);

        expect(result).toEqual({ query: "na", startIndex: 6 });
    });

    it("should return undefined when no open braces", () => {
        expect(parseVariableMatch("Hello world", 5)).toBeUndefined();
    });

    it("should return undefined when variable is already closed", () => {
        expect(parseVariableMatch("Hello {{name}} more", 15)).toBeUndefined();
    });

    it("should handle empty query after braces", () => {
        const result = parseVariableMatch("Hello {{", 8);

        expect(result).toEqual({ query: "", startIndex: 6 });
    });

    it("should return undefined for invalid characters in query", () => {
        expect(parseVariableMatch("Hello {{na me", 13)).toBeUndefined();
    });
});

describe("filterVariables", () => {
    const variables = [
        { description: "User name", name: "user.name" },
        { description: "User email", name: "user.email" },
        { description: "Current date", name: "context.date" },
    ];

    it("should return all when query is empty", () => {
        expect(filterVariables(variables, "")).toEqual(variables);
    });

    it("should filter by name", () => {
        expect(filterVariables(variables, "email")).toHaveLength(1);
        expect(filterVariables(variables, "email")[0]!.name).toBe("user.email");
    });

    it("should filter by description", () => {
        const result = filterVariables(variables, "current");

        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe("context.date");
    });

    it("should be case insensitive", () => {
        expect(filterVariables(variables, "USER")).toHaveLength(2);
    });
});

describe("isSystemManagedVariable", () => {
    it("should return true for context variables", () => {
        expect(isSystemManagedVariable("context.date")).toBe(true);
        expect(isSystemManagedVariable("context.timezone")).toBe(true);
    });

    it("should return true for user variables", () => {
        expect(isSystemManagedVariable("user.name")).toBe(true);
        expect(isSystemManagedVariable("user.email")).toBe(true);
    });

    it("should return false for custom variables", () => {
        expect(isSystemManagedVariable("brand")).toBe(false);
        expect(isSystemManagedVariable("custom.field")).toBe(false);
    });
});

describe("formatVariable", () => {
    it("should wrap name in double braces", () => {
        expect(formatVariable("name")).toBe("{{name}}");
        expect(formatVariable("user.email")).toBe("{{user.email}}");
    });
});

describe("highlightVariables", () => {
    it("should wrap variables in span tags", () => {
        const result = highlightVariables("Hello {{name}}");

        expect(result).toContain("<span");
        expect(result).toContain("{{name}}");
    });

    it("should leave text without variables unchanged", () => {
        expect(highlightVariables("Hello world")).toBe("Hello world");
    });
});

describe("getAllCommonVariables", () => {
    it("should return a flat array of common variables", () => {
        const variables = getAllCommonVariables(i18n);

        expect(variables.length).toBeGreaterThan(0);
        expect(variables.every((v) => v.name && v.description)).toBe(true);
    });

    it("should include user and conversation variables", () => {
        const variables = getAllCommonVariables(i18n);
        const names = variables.map((v) => v.name);

        expect(names).toContain("user.name");
        expect(names).toContain("conversation.summary");
    });

    it("should translate the descriptions", () => {
        expect(getAllCommonVariables(i18n)).toContainEqual({ description: "«User's display name»", name: "user.name" });
    });
});
