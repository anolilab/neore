/**
 * Client-side model for the Agent Builder: which recommendations the user
 * accepted, the payloads built from them, and the refine diff.
 *
 * Accepting an item only changes what `createSkill` receives on save (or what a
 * test drive runs with). Nothing is installed or enabled from here — an
 * accepted MCP server becomes a prefilled add-server form the user confirms.
 */
import type { ReturnOf } from "@lunora/react";
import type { api } from "@neore/backend/api";

import type { ConnectorDisplayStatus, ConnectorStatusSource } from "@/features/settings/connectors/connector-status";
import { connectorDisplayStatus } from "@/features/settings/connectors/connector-status";

type TurnResult = ReturnOf<typeof api.skills.builder.runBuilderTurn>;

export type BuilderDraft = Extract<TurnResult, { kind: "draft" }>["draft"];
export type BuilderRecommendations = Extract<TurnResult, { kind: "draft" }>["recommendations"];
export type BuilderQuestion = Extract<TurnResult, { kind: "questions" }>["questions"][number];
export type RecommendedMcpServer = BuilderRecommendations["mcpServers"][number];

export interface BuilderAcceptance {
    connectors: Record<string, boolean>;
    disableTools: Record<string, boolean>;
    enableTools: Record<string, boolean>;
    mcpServers: Record<string, boolean>;
    preferredModel: boolean;
    reasoningEffort: boolean;
    searchMode: boolean;
}

const allOf = (names: string[], value: boolean): Record<string, boolean> => Object.fromEntries(names.map((name) => [name, value]));

/**
 * Draft settings start accepted — they ARE the draft. External things (MCP
 * servers, connectors) start rejected: reaching outside the app is opt-in.
 */
export const defaultAcceptance = (draft: BuilderDraft, recommendations: BuilderRecommendations): BuilderAcceptance => {
    return {
        connectors: allOf(
            recommendations.connectors.map((connector) => connector.id),
            false,
        ),
        disableTools: allOf(
            draft.disableTools.map((tool) => tool.name),
            true,
        ),
        enableTools: allOf(
            draft.enableTools.map((tool) => tool.name),
            true,
        ),
        mcpServers: allOf(
            recommendations.mcpServers.map((item) => item.server.id),
            false,
        ),
        preferredModel: true,
        reasoningEffort: true,
        searchMode: true,
    };
};

/**
 * Carry the user's choices over to a refined draft: an item that survived keeps
 * its accept/reject, a new one starts accepted like any draft setting.
 */
export const carryAcceptance = (previous: BuilderAcceptance, draft: BuilderDraft): BuilderAcceptance => {
    const carry = (names: string[], old: Record<string, boolean>) => Object.fromEntries(names.map((name) => [name, old[name] ?? true]));

    return {
        ...previous,
        disableTools: carry(
            draft.disableTools.map((tool) => tool.name),
            previous.disableTools,
        ),
        enableTools: carry(
            draft.enableTools.map((tool) => tool.name),
            previous.enableTools,
        ),
    };
};

export interface SkillRunConfig {
    additionalTools?: string[];
    disabledTools?: string[];
    preferredModel?: string;
    reasoningEffort?: number;
    searchMode?: string;
}

/** The skill `config` the accepted items produce — for save and for a test drive alike. */
export const toSkillConfig = (draft: BuilderDraft, acceptance: BuilderAcceptance): SkillRunConfig => {
    const additionalTools = draft.enableTools.filter((tool) => acceptance.enableTools[tool.name]).map((tool) => tool.name);
    const disabledTools = draft.disableTools.filter((tool) => acceptance.disableTools[tool.name]).map((tool) => tool.name);

    return {
        ...(additionalTools.length > 0 && { additionalTools }),
        ...(disabledTools.length > 0 && { disabledTools }),
        ...(draft.preferredModel && acceptance.preferredModel && { preferredModel: draft.preferredModel.id }),
        ...(draft.reasoningEffort && acceptance.reasoningEffort && { reasoningEffort: draft.reasoningEffort.value }),
        ...(draft.searchMode && acceptance.searchMode && { searchMode: draft.searchMode.id }),
    };
};

/** `createSkill` arguments. Private by default; sharing is a later, deliberate edit. */
export const toCreateSkillArgs = (draft: BuilderDraft, acceptance: BuilderAcceptance) => {
    return {
        category: draft.category,
        config: toSkillConfig(draft, acceptance),
        description: draft.description.trim(),
        instructions: draft.instructions.trim(),
        name: draft.name.trim(),
        slug: draft.slug.trim(),
        source: { type: "editor" as const },
        tags: draft.tags,
        variables: draft.variables,
        visibility: "private" as const,
    };
};

export const acceptedMcpServers = (recommendations: BuilderRecommendations, acceptance: BuilderAcceptance): RecommendedMcpServer[] =>
    recommendations.mcpServers.filter((item) => acceptance.mcpServers[item.server.id]);

export const acceptedConnectors = (recommendations: BuilderRecommendations, acceptance: BuilderAcceptance): BuilderRecommendations["connectors"] =>
    recommendations.connectors.filter((connector) => acceptance.connectors[connector.id]);

// ============================================================================
// Refine diff
// ============================================================================

export type DiffLine = { kind: "added" | "removed" | "same"; text: string };

export interface FieldDiff {
    after: string;
    before: string;
    field: string;
    /** Line-level diff, for multi-line fields (instructions). */
    lines?: DiffLine[];
}

const MAX_LCS_CELLS = 250_000;

/**
 * Line diff by longest common subsequence. Above ~500×500 lines the table gets
 * expensive, so it degrades to "all removed, all added" — still correct, just
 * less precise.
 */
export const diffLines = (before: string, after: string): DiffLine[] => {
    const a = before.split("\n");
    const b = after.split("\n");

    if (a.length * b.length > MAX_LCS_CELLS) {
        return [
            ...a.map((text): DiffLine => {
                return { kind: "removed", text };
            }),
            ...b.map((text): DiffLine => {
                return { kind: "added", text };
            }),
        ];
    }

    // Zero-initialised rows: table[i][j] is the LCS length of a[i..] and b[j..].
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));

    for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
            table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
        }
    }

    const result: DiffLine[] = [];
    let i = 0;
    let j = 0;

    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            result.push({ kind: "same", text: a[i]! });
            i += 1;
            j += 1;
        } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
            result.push({ kind: "removed", text: a[i]! });
            i += 1;
        } else {
            result.push({ kind: "added", text: b[j]! });
            j += 1;
        }
    }

    for (; i < a.length; i += 1) {
        result.push({ kind: "removed", text: a[i]! });
    }

    for (; j < b.length; j += 1) {
        result.push({ kind: "added", text: b[j]! });
    }

    return result;
};

/** A field's value as one comparable, displayable string. */
export const formatDraftField = (draft: BuilderDraft, field: string): string => {
    switch (field) {
        case "category":
        case "description":
        case "instructions":
        case "name":
        case "slug": {
            return draft[field] ?? "";
        }
        case "disableTools":
        case "enableTools": {
            return draft[field].map((tool) => tool.name).join(", ");
        }
        case "preferredModel": {
            return draft.preferredModel?.name ?? "";
        }
        case "reasoningEffort": {
            return draft.reasoningEffort === undefined ? "" : String(draft.reasoningEffort.value);
        }
        case "searchMode": {
            return draft.searchMode?.id ?? "";
        }
        case "tags": {
            return draft.tags.join(", ");
        }
        case "variables": {
            return draft.variables.map((variable) => `{{${variable.name}}}${variable.required ? " *" : ""}`).join(", ");
        }
        default: {
            return "";
        }
    }
};

/**
 * The diff to show after a refinement, for the fields the backend reported as
 * changed. A field whose displayed value did not change (a rationale edit, say)
 * is left out — it would render as an empty diff.
 */
export const buildDraftDiff = (before: BuilderDraft, after: BuilderDraft, changedFields: ReadonlyArray<string>): FieldDiff[] =>
    changedFields.flatMap((field) => {
        const previous = formatDraftField(before, field);
        const next = formatDraftField(after, field);

        if (previous === next) {
            return [];
        }

        return [{ after: next, before: previous, field, ...(field === "instructions" && { lines: diffLines(previous, next) }) }];
    });

// ============================================================================
// Connector status
// ============================================================================

export type ConnectorStatus = "available" | "connected" | "expired" | "notConfigured";

/** The fields of a `listConnectorCatalog` entry the status reads. */
export interface ConnectorCatalogEntry extends ConnectorStatusSource {
    slug: string;
}

/** The builder's four states over the settings page's five: an errored connection needs reconnecting, as an expired one does. */
const BUILDER_STATUS: Record<ConnectorDisplayStatus, ConnectorStatus> = {
    connected: "connected",
    error: "expired",
    expired: "expired",
    not_configured: "notConfigured",
    not_connected: "available",
};

/**
 * One recommended connector's state for this user, read the way the connectors
 * settings page reads it (`connectorDisplayStatus`). A slug missing from the
 * catalogue cannot be connected here, so it reads as not configured.
 */
export const connectorStatus = (entry: ConnectorCatalogEntry | undefined, now: number): ConnectorStatus =>
    entry ? BUILDER_STATUS[connectorDisplayStatus(entry, now)] : "notConfigured";

export const connectorStatuses = (
    catalog: ReadonlyArray<ConnectorCatalogEntry> | undefined,
    slugs: ReadonlyArray<string>,
    now: number,
): Record<string, ConnectorStatus> => {
    const bySlug = new Map((catalog ?? []).map((entry) => [entry.slug, entry]));

    return Object.fromEntries(slugs.map((slug) => [slug, connectorStatus(bySlug.get(slug), now)]));
};

/**
 * Whether "Connect" makes sense: not while the status is unknown-yet-loading
 * (undefined counts as actionable, so the button does not flicker away), not
 * when already connected, not when the operator has no client credentials.
 */
export const isConnectorActionable = (status: ConnectorStatus | undefined): boolean => status !== "connected" && status !== "notConfigured";
