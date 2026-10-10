/**
 * Utility functions for handling dynamic variables in prompts
 *
 * Variables use the syntax: {{variableName}} or {{category.variableName}}
 * Examples: {{BRAND}}, {{customer.name}}, {{conversation.summary}}
 *
 * Note: Variables starting with "context." or "user." are system-managed
 * and cannot be edited by users. They are automatically populated.
 */

import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

const VARIABLE_TOKEN_RE = /\{\{[a-z_][\w.]*\}\}/i;
const VARIABLE_QUERY_RE = /^[\w.]*$/;

/** Default lexicographic (UTF-16 code unit) order — the same order `Array#sort` uses for strings. */
const byCodeUnit = (a: string, b: string): number => {
    if (a === b) {
        return 0;
    }

    return a < b ? -1 : 1;
};

export interface PromptVariable {
    defaultValue?: string;
    description?: string;
    name: string;
    required?: boolean;
}

// Regex to match variables in the format {{variableName}} or {{category.variable}}
const VARIABLE_REGEX = /\{\{([a-z_][\w.]*)\}\}/gi;

/**
 * Extract all variable names from prompt content.
 */
export const extractVariables = (content: string): string[] => {
    const matches = content.matchAll(VARIABLE_REGEX);
    const variables = new Set<string>();

    for (const match of matches) {
        variables.add(match[1] ?? "");
    }

    return [...variables].toSorted(byCodeUnit);
};

/**
 * Check if a string contains any variables.
 */
export const hasVariables = (content: string): boolean => VARIABLE_TOKEN_RE.test(content);

/**
 * Replace variables in content with their values.
 */
export const replaceVariables = (content: string, values: Record<string, string>, options?: { keepUnmatched?: boolean }): string =>
    content.replaceAll(VARIABLE_REGEX, (match: string, variableName: string) => {
        if (Object.hasOwn(values, variableName)) {
            return values[variableName] as string;
        }

        return options?.keepUnmatched ? match : `[${variableName}]`;
    });

/**
 * Replace variables with their default values from variable definitions.
 */
export const replaceWithDefaults = (content: string, variables: PromptVariable[]): string => {
    const defaults: Record<string, string> = {};

    for (const variable of variables) {
        if (variable.defaultValue) {
            defaults[variable.name] = variable.defaultValue;
        }
    }

    return replaceVariables(content, defaults, { keepUnmatched: true });
};

/**
 * Validate that all required variables have values.
 */
export const validateVariables = (content: string, variables: PromptVariable[], values: Record<string, string>): { missing: string[]; valid: boolean } => {
    const requiredVariables = variables.filter((v) => v.required);
    const usedVariables = new Set(extractVariables(content));
    const missing: string[] = [];

    for (const variable of requiredVariables) {
        const value = values[variable.name];

        if (usedVariables.has(variable.name) && !value) {
            missing.push(variable.name);
        }
    }

    return {
        missing,
        valid: missing.length === 0,
    };
};

/**
 * Sync variable definitions with variables found in content
 * Adds new variables found in content, keeps existing definitions.
 */
export const syncVariablesWithContent = (content: string, existingVariables: PromptVariable[]): PromptVariable[] => {
    const usedVariableNames = extractVariables(content);
    const existingMap = new Map(existingVariables.map((v) => [v.name, v]));
    const synced: PromptVariable[] = [];

    // Add all used variables, preserving existing definitions
    for (const name of usedVariableNames) {
        const existing = existingMap.get(name);

        if (existing) {
            synced.push(existing);
        } else {
            synced.push({ name });
        }
    }

    return synced;
};

interface CommonVariableCategory<Text> {
    description: Text;
    variables: ReadonlyArray<{ description: Text; name: string }>;
}

/**
 * Common variable categories with predefined variables. Descriptions are
 * message descriptors — resolve them with `getCommonVariableCategories(i18n)`.
 */
export const COMMON_VARIABLE_CATEGORIES = {
    conversation: {
        description: msg`Conversation data`,
        variables: [
            { description: msg`Last message from the customer`, name: "conversation.lastCustomerMessage" },
            { description: msg`Summary of the conversation`, name: "conversation.summary" },
            { description: msg`Conversation history`, name: "conversation.history" },
            { description: msg`Number of messages`, name: "conversation.messageCount" },
        ],
    },
    user: {
        description: msg`User information`,
        variables: [
            { description: msg`User's display name`, name: "user.name" },
            { description: msg`User's email address`, name: "user.email" },
            { description: msg`User's role`, name: "user.role" },
            { description: msg`User's organization`, name: "user.organization" },
        ],
    },
} as const satisfies Record<string, CommonVariableCategory<MessageDescriptor>>;

export type CommonVariableCategoryKey = keyof typeof COMMON_VARIABLE_CATEGORIES;

/**
 * The common variable categories with their descriptions in the reader's language.
 */
export const getCommonVariableCategories = (i18n: I18n): Record<CommonVariableCategoryKey, CommonVariableCategory<string>> => {
    const localize = (category: CommonVariableCategory<MessageDescriptor>): CommonVariableCategory<string> => {
        return {
            description: i18n._(category.description),
            variables: category.variables.map((variable) => {
                return { description: i18n._(variable.description), name: variable.name };
            }),
        };
    };

    return {
        conversation: localize(COMMON_VARIABLE_CATEGORIES.conversation),
        user: localize(COMMON_VARIABLE_CATEGORIES.user),
    };
};

/**
 * Get all common variables as a flat array.
 */
export const getAllCommonVariables = (i18n: I18n): PromptVariable[] =>
    Object.values(getCommonVariableCategories(i18n)).flatMap((category) =>
        category.variables.map((v) => {
            return { ...v };
        }),
    );

/**
 * Highlight variables in content for display (returns HTML string).
 */
export const highlightVariables = (content: string): string =>
    content.replaceAll(
        VARIABLE_REGEX,
        '<span class="!text-primary bg-primary/20 rounded px-1 font-mono text-sm" style="color: hsl(var(--primary)) !important;">{{$1}}</span>',
    );

/**
 * Format a variable for insertion into the prompt.
 */
export const formatVariable = (name: string): string => `{{${name}}}`;

/**
 * User context for auto-populated variables
 */
export interface UserContext {
    email?: string;
    name?: string;
    organization?: string;
    role?: string;
}

/**
 * Get auto-populated system variables based on current context
 * These are generated dynamically and cannot be overridden by users.
 */
export const getAutoPopulatedVariables = (userContext?: UserContext): Record<string, string> => {
    const now = new Date();
    // Context variables
    const values: Record<string, string> = {
        "context.currentDate": now.toLocaleDateString(undefined, { dateStyle: "full" }),
        "context.currentTime": now.toLocaleTimeString(undefined, { timeStyle: "short" }),
        "context.dayOfWeek": now.toLocaleDateString(undefined, { weekday: "long" }),
        "context.language": navigator.language,
        "context.month": now.toLocaleDateString(undefined, { month: "long" }),
        "context.timezone": new Intl.DateTimeFormat().resolvedOptions().timeZone,
        "context.year": now.getFullYear().toString(),
    };

    // User variables (if context provided)
    if (userContext) {
        if (userContext.name) {
            values["user.name"] = userContext.name;
        }

        if (userContext.email) {
            values["user.email"] = userContext.email;
        }

        if (userContext.role) {
            values["user.role"] = userContext.role;
        }

        if (userContext.organization) {
            values["user.organization"] = userContext.organization;
        }
    }

    return values;
};

/**
 * List of auto-populated variable names (for documentation/UI)
 */
export const AUTO_POPULATED_VARIABLES = [
    { description: "Full date (e.g., Monday, January 1, 2025)", name: "context.currentDate" },
    { description: "Current time (e.g., 2:30 PM)", name: "context.currentTime" },
    { description: "User's timezone (e.g., America/New_York)", name: "context.timezone" },
    { description: "Browser language (e.g., en-US)", name: "context.language" },
    { description: "Current year (e.g., 2025)", name: "context.year" },
    { description: "Current month name (e.g., January)", name: "context.month" },
    { description: "Current day of week (e.g., Monday)", name: "context.dayOfWeek" },
    { description: "User's display name", name: "user.name" },
    { description: "User's email address", name: "user.email" },
    { description: "User's role", name: "user.role" },
    { description: "User's organization", name: "user.organization" },
] as const;

// ============================================================================
// Variable Autocomplete Utilities
// ============================================================================

/**
 * Match result for an open variable pattern ({{ without closing }})
 */
export interface VariableMatch {
    /** The query typed after {{ */
    query: string;
    /** Start index of {{ in the text */
    startIndex: number;
}

/**
 * Parse the text to find an open variable pattern ({{ without closing }}).
 */
export const parseVariableMatch = (text: string, cursorPosition: number): VariableMatch | undefined => {
    // Find the last {{ before cursor
    const beforeCursor = text.slice(0, cursorPosition);
    const lastOpenIndex = beforeCursor.lastIndexOf("{{");

    if (lastOpenIndex === -1) {
        return undefined;
    }

    // Check if there's a closing }} between {{ and cursor
    const afterOpen = beforeCursor.slice(lastOpenIndex);

    if (afterOpen.includes("}}")) {
        return undefined;
    }

    // Extract the query (text after {{)
    const query = afterOpen.slice(2).toLowerCase();

    // Only match if query contains valid variable characters
    if (query && !VARIABLE_QUERY_RE.test(query)) {
        return undefined;
    }

    return {
        query,
        startIndex: lastOpenIndex,
    };
};

/**
 * Filter variables by query.
 */
export const filterVariables = (variables: { description: string; name: string }[], query: string): { description: string; name: string }[] => {
    if (!query) {
        return variables;
    }

    const lowerQuery = query.toLowerCase();

    return variables.filter((v) => v.name.toLowerCase().includes(lowerQuery) || v.description.toLowerCase().includes(lowerQuery));
};

/**
 * Variable item for autocomplete
 */
export interface VariableItem {
    category: string;
    description?: string;
    name: string;
}

/**
 * Check if a variable is system-managed and cannot be edited by users.
 */
export const isSystemManagedVariable = (variableName: string): boolean => variableName.startsWith("context.") || variableName.startsWith("user.");

/**
 * Get all filtered variables as a flat array for keyboard navigation.
 */
export const getAllFilteredVariables = (customVariables: PromptVariable[], query: string, i18n: I18n): VariableItem[] => {
    const result: VariableItem[] = [];

    // Add custom variables first (filter out system-managed ones)
    const filteredCustom = filterVariables(
        customVariables.flatMap((v) => (isSystemManagedVariable(v.name) ? [] : [{ description: v.description ?? "", name: v.name }])),
        query,
    );

    for (const v of filteredCustom) {
        result.push({ ...v, category: "custom" });
    }

    // Add common variables
    const commonCategories = Object.entries(getCommonVariableCategories(i18n));

    for (const [categoryKey, category] of commonCategories) {
        const filtered = filterVariables([...category.variables], query);

        for (const v of filtered) {
            result.push({ ...v, category: categoryKey });
        }
    }

    return result;
};
