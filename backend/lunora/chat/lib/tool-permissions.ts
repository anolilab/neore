/**
 * Per-tool permission layer.
 *
 * Every tool the agent can see — built-ins, MCP tools, connector tools — resolves
 * to one of three modes:
 *
 * - `auto` — the model may call it freely.
 * - `ask`  — the call pauses as a `tool-approval-request` until the user approves
 *            or denies it (AI SDK `needsApproval`).
 * - `off`  — the tool is removed from the tool set; the model never sees it.
 *
 * The user's overrides live in `aiUserPreferences.toolPermissions`, keyed by the
 * STABLE key from {@link toolPermissionKey} — not the runtime tool name, because
 * the runtime name of an MCP tool embeds a sanitised server name that cannot be
 * mapped back. The key is derived where the tool is built (`getMCPTools`'s
 * descriptors) and carried alongside it, never parsed out of the runtime name.
 *
 * Headless callers (triggers, messenger, workflows) pass `headless: true`: nobody
 * is there to answer an approval request, so `ask` degrades to `off` rather than
 * being silently auto-approved. The one exception is a consent the run INHERITS
 * (`headlessApproved`, see {@link resolveToolPermission}).
 *
 * Device tools (`device-tools.ts`) run on the user's own computer and are
 * approved THERE, in the desktop shell's local window — so their chat-side
 * default is `auto` (a second prompt would ask twice), and headless they are
 * removed whatever the mode: nobody is at the device to approve.
 */
import type { ToolSet } from "ai";

import type { ToolPermissionGrants } from "./tool-permission-grants";
import { BUILTIN_TOOLS_NEEDING_A_PERSON } from "./person-tools";
import { grantExpiryFor } from "./tool-permission-grants";

export type ToolPermissionMode = "auto" | "ask" | "off";

export type ToolSource = "builtin" | "connector" | "device" | "mcp";

/** The subset of MCP `ToolAnnotations` the defaults read. Untrusted hints. */
export interface ToolAnnotationHints {
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
}

export interface ToolDescriptor {
    annotations?: ToolAnnotationHints;
    /** Stable preference key, see {@link toolPermissionKey}. */
    key: string;
    source: ToolSource;
}

export type ToolPermissionOverrides = Record<string, ToolPermissionMode>;

export const TOOL_PERMISSION_MODES: ReadonlyArray<ToolPermissionMode> = ["auto", "ask", "off"];

export const isToolPermissionMode = (value: unknown): value is ToolPermissionMode =>
    typeof value === "string" && (TOOL_PERMISSION_MODES as ReadonlyArray<string>).includes(value);

/**
 * Stable preference key for a tool.
 *
 * - built-in:  `builtin:<toolName>`
 * - MCP:       `mcp:<serverName>:<toolName>`
 * - connector: `connector:<slug>:<toolName>`
 * - device:    `device:<deviceId>:<toolName>`
 */
export const toolPermissionKey = (source: ToolSource, toolName: string, owner?: string): string => {
    if (source === "builtin") {
        return `builtin:${toolName}`;
    }

    return `${source}:${owner ?? ""}:${toolName}`;
};

/**
 * Built-ins that default to `ask`. `delegateToCodingAgent` spends the user's
 * own provider key on a long sandbox run and can push to their GitHub;
 * `delegateToSubAgent` and `messageWorker` start a background run charged to their task quota —
 * so the user sees the task before anything starts. Headless callers lose them
 * (`ask` degrades to `off`), which is intended — except a sub-agent's own
 * delegation, which inherits the consent its parent call was given
 * (`sub-agents/execute.ts`).
 */
export const BUILTIN_TOOLS_ASK_BY_DEFAULT: ReadonlySet<string> = new Set(["askUser", "delegateToCodingAgent", "delegateToSubAgent", "messageWorker"]);

const SUB_AGENT_BUILTINS: ReadonlySet<string> = new Set(["delegateToSubAgent", "messageWorker"]);

export { BUILTIN_TOOLS_NEEDING_A_PERSON } from "./person-tools";

/**
 * Default mode when the user has not chosen one.
 *
 * Built-ins are ours and default to `auto`, except {@link BUILTIN_TOOLS_ASK_BY_DEFAULT}
 * (`toolName` is the built-in's name). Third-party tools default to `ask`
 * unless they declare themselves read-only; a tool that ALSO claims to be
 * destructive never defaults to `auto`, whatever else it says.
 */
export const defaultToolPermission = (source: ToolSource, annotations?: ToolAnnotationHints, toolName?: string): ToolPermissionMode => {
    if (source === "builtin") {
        return toolName !== undefined && BUILTIN_TOOLS_ASK_BY_DEFAULT.has(toolName) ? "ask" : "auto";
    }

    // Approved on the device itself; see the module comment.
    if (source === "device") {
        return "auto";
    }

    if (annotations?.destructiveHint === true) {
        return "ask";
    }

    return annotations?.readOnlyHint === true ? "auto" : "ask";
};

export interface ToolPermissionOptions {
    /**
     * The run was started with an API key: no device tool or sub-agent, and nothing above `ask`, whatever the user's
     * overrides say. A person approves in the app; the outside agent cannot.
     */
    apiKeyOrigin?: boolean;
    headless?: boolean;
    /**
     * Built-in names whose `ask` this headless run already has an answer to,
     * so they run as `auto` instead of being removed. Only a run STARTED by an
     * approved call of that tool may pass one — a sub-agent child, whose
     * parent's `delegateToSubAgent` call only executed past the permission
     * check. `off` stays off, and a tool that needs a person is still removed.
     */
    headlessApproved?: ReadonlySet<string>;
    /** The instant the grants are judged at. Defaults to the clock. */
    now?: number;
    /**
     * The user's time-boxed allows (`tool-permission-grants.ts`). They turn an `ask` into an `auto` for an interactive run only: a
     * headless run inherits nothing, and `off` stays off.
     */
    timedGrants?: ToolPermissionGrants;
}

export interface ResolvedToolPermission {
    mode: ToolPermissionMode;
    /** Set when `mode` is `auto` only because a time-boxed allow covers the tool until then. */
    timedUntil?: number;
}

/**
 * Effective mode for one tool: override, else default, then the headless clamp.
 */
export const resolveToolPermission = (
    descriptor: ToolDescriptor,
    overrides: ToolPermissionOverrides | null | undefined,
    options: ToolPermissionOptions = {},
): ToolPermissionMode => resolveToolPermissionWithGrant(descriptor, overrides, options).mode;

/** The effective mode as {@link resolveToolPermission} answers it, plus the time-boxed allow that lifted the tool, if one did. */
export const resolveToolPermissionWithGrant = (
    descriptor: ToolDescriptor,
    overrides: ToolPermissionOverrides | null | undefined,
    options: ToolPermissionOptions = {},
): ResolvedToolPermission => {
    const override = overrides?.[descriptor.key];
    const builtinName = descriptor.source === "builtin" ? descriptor.key.slice("builtin:".length) : undefined;
    let chosen = isToolPermissionMode(override) ? override : defaultToolPermission(descriptor.source, descriptor.annotations, builtinName);
    let timedUntil: number | undefined;

    // Before the origin clamp below, so an outside agent's grant-lifted tool is still `ask`.
    if (chosen === "ask" && !options.headless && descriptor.source !== "device") {
        timedUntil = grantExpiryFor(options.timedGrants, descriptor.key, options.now ?? Date.now());

        if (timedUntil !== undefined) {
            chosen = "auto";
        }
    }

    if (options.apiKeyOrigin && descriptor.source === "device") {
        return { mode: "off" };
    }

    // A sub-agent runs headless and does not carry the run's origin, so its auto tools would run
    // unattended: an outside agent cannot start one.
    if (options.apiKeyOrigin && builtinName !== undefined && SUB_AGENT_BUILTINS.has(builtinName)) {
        return { mode: "off" };
    }

    const mode = options.apiKeyOrigin && chosen === "auto" ? "ask" : chosen;

    if (!options.headless) {
        return mode === "auto" && timedUntil !== undefined ? { mode, timedUntil } : { mode };
    }

    if (descriptor.source === "device") {
        return { mode: "off" };
    }

    if (builtinName !== undefined && BUILTIN_TOOLS_NEEDING_A_PERSON.has(builtinName)) {
        return { mode: "off" };
    }

    if (mode === "ask") {
        return { mode: builtinName !== undefined && options.headlessApproved?.has(builtinName) ? "auto" : "off" };
    }

    return { mode };
};

/** Reads MCP annotations off an `@ai-sdk/mcp` tool (`metadata.annotations`). */
export const readMcpAnnotations = (tool: unknown): ToolAnnotationHints | undefined =>
    (tool as { metadata?: { annotations?: ToolAnnotationHints } } | undefined)?.metadata?.annotations;

/**
 * Apply permissions to a tool set.
 *
 * `describe` maps a runtime tool name to its descriptor; a tool it returns
 * `undefined` for is treated as a built-in keyed by its runtime name.
 *
 * `ask` tools are shallow-copied with `needsApproval: true`. Copying (rather than
 * mutating) matters: built-in tools are module-level singletons shared by every
 * request, and `createTool`'s own `needsApproval` is an own property the spread
 * overrides.
 */
export const applyToolPermissions = (
    tools: ToolSet,
    describe: (runtimeName: string) => ToolDescriptor | undefined,
    overrides: ToolPermissionOverrides | null | undefined,
    options: ToolPermissionOptions = {},
): { removed: string[]; requiresApproval: string[]; tools: ToolSet } => {
    const result: ToolSet = {};
    const removed: string[] = [];
    const requiresApproval: string[] = [];

    for (const [name, tool] of Object.entries(tools)) {
        const descriptor = describe(name) ?? { key: toolPermissionKey("builtin", name), source: "builtin" as const };
        const { mode, timedUntil } = resolveToolPermissionWithGrant(descriptor, overrides, options);

        if (mode === "off") {
            removed.push(name);
            continue;
        }

        if (mode === "ask") {
            requiresApproval.push(name);
            result[name] = { ...tool, needsApproval: true } as ToolSet[string];
            continue;
        }

        // Tools are built once per run and a run can outlast the grant, so the lapse is checked at every call.
        result[name] = timedUntil === undefined ? tool : ({ ...tool, needsApproval: () => Date.now() >= timedUntil } as ToolSet[string]);
    }

    return { removed, requiresApproval, tools: result };
};
