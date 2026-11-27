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
 * being silently auto-approved. The exceptions are a consent the run INHERITS
 * (`headlessApproved`, see {@link resolveToolPermission}) and a run that pauses
 * for its owner's answer instead (`headlessCanAsk`, a sub-agent child).
 *
 * Device tools (`device-tools.ts`) run on the user's own computer and are
 * approved THERE, in the desktop shell's local window — so their chat-side
 * default is `auto` (a second prompt would ask twice), and headless they are
 * removed whatever the mode: nobody is at the device to approve.
 */
import type { ToolSet } from "ai";

import type { LowRiskCheck } from "./low-risk-approval";
import { lowRiskIneligibleReason } from "./low-risk-approval";
import type { ToolPermissionGrants } from "./tool-permission-grants";
import { BUILTIN_TOOLS_NEEDING_A_PERSON } from "./person-tools";
import type { ThreadPermissionMode } from "./thread-permission-mode";
import { BUILTIN_TOOLS_READ_ONLY } from "./thread-permission-mode";
import { grantExpiryFor } from "./tool-permission-grants";

export type ToolPermissionMode = "auto" | "ask" | "off";

export type ToolSource = "builtin" | "connector" | "device" | "mcp";

/** The subset of MCP `ToolAnnotations` the defaults read. Untrusted hints. */
export interface ToolAnnotationHints {
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    readOnlyHint?: boolean;
}

export interface ToolDescriptor {
    annotations?: ToolAnnotationHints;
    /** Stable preference key, see {@link toolPermissionKey}. */
    key: string;
    source: ToolSource;
    /** The server's entry in the user's quick-check trust list (`low-risk-trust.ts`). Absent: no known server, so never trusted. */
    trustId?: string;
}

export type ToolPermissionOverrides = Record<string, ToolPermissionMode>;

export const TOOL_PERMISSION_MODES: ReadonlyArray<ToolPermissionMode> = ["auto", "ask", "off"];

export const isToolPermissionMode = (value: unknown): value is ToolPermissionMode =>
    typeof value === "string" && (TOOL_PERMISSION_MODES as ReadonlyArray<string>).includes(value);

const MODE_RANK: Record<ToolPermissionMode, number> = { ask: 1, auto: 2, off: 0 };

/** The lower of a mode and a cap, in the order `off` < `ask` < `auto`. */
export const clampToolPermission = (mode: ToolPermissionMode, cap: ToolPermissionMode): ToolPermissionMode => (MODE_RANK[mode] <= MODE_RANK[cap] ? mode : cap);

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
 * Built-ins that default to `ask`. `canvasAI` and the paid generation tools (imageGeneration, imageEditing, videoGeneration,
 * musicGeneration) ask too: a default `auto` would run a paid call with no approval for anyone who has not set an override. `delegateToCodingAgent` spends the user's
 * own provider key on a long sandbox run and can push to their GitHub;
 * `delegateToSubAgent` and `messageWorker` start a background run charged to their task quota —
 * so the user sees the task before anything starts. `watchPullRequest` starts runs that wake the thread later, each one charged like a
 * chat reply, and `unwatchPullRequest` stops them (text from a pull request must not be able to silence the person's own watch). `replyToReviewComment` and `rerunFailedChecks` act on a pull request
 * as the user (`mergePullRequest` asks every time: it needs a person; so does `signInWithSavedLogin`, which types a saved
 * password for them). Headless callers lose them
 * (`ask` degrades to `off`), which is intended — except a sub-agent's own
 * delegation, which inherits the consent its parent call was given
 * (`sub-agents/execute.ts`).
 */
export const BUILTIN_TOOLS_ASK_BY_DEFAULT: ReadonlySet<string> = new Set([
    "askUser",
    "canvasAI",
    "delegateToCodingAgent",
    "delegateToSubAgent",
    "imageEditing",
    "imageGeneration",
    "mergePullRequest",
    "messageWorker",
    "musicGeneration",
    "replyToReviewComment",
    "requestSecret",
    "rerunFailedChecks",
    "signInWithSavedLogin",
    "unwatchPullRequest",
    "videoGeneration",
    "watchPullRequest",
]);

const SUB_AGENT_BUILTINS: ReadonlySet<string> = new Set(["delegateToSubAgent", "messageWorker"]);

/**
 * Built-ins that "Always allow" never grants. Each one spends money or sends something out as the person, and a stored
 * `auto` would let every later call run unasked. An `always` answer for them is refused and the call still asks; an hour
 * or today allow is unaffected.
 *
 * - imageGeneration, imageEditing, videoGeneration, musicGeneration: paid per generation on a metered provider (FAL),
 *   each one counted against the user's daily bucket.
 * - canvasAI: its generate and style operations call the same image generation and editing actions, so it is paid too.
 * - delegateToCodingAgent: spends the user's own provider key on a sandbox run that can push to their GitHub.
 * - delegateToSubAgent, messageWorker: start a run charged to the task quota, or send more work to a worker.
 * - replyToReviewComment: posts a comment on a pull request as the person.
 * - rerunFailedChecks: re-runs checks on a pull request with the person's GitHub access.
 * - mergePullRequest: merges a pull request as the person.
 * - signInWithSavedLogin: types a saved password for the person into a site.
 *
 * `tool-permissions.grants.test.ts` checks that every name here is a real built-in.
 */
export const ALWAYS_ALLOW_REFUSED_BUILTINS: ReadonlySet<string> = new Set([
    "canvasAI",
    "delegateToCodingAgent",
    "delegateToSubAgent",
    "imageEditing",
    "imageGeneration",
    "mergePullRequest",
    "messageWorker",
    "musicGeneration",
    "replyToReviewComment",
    "rerunFailedChecks",
    "signInWithSavedLogin",
    "unwatchPullRequest",
    "videoGeneration",
    "watchPullRequest",
]);

/** Whether an `always` answer for this permission key is refused: a built-in listed in {@link ALWAYS_ALLOW_REFUSED_BUILTINS}. */
export const isAlwaysAllowRefused = (key: string): boolean => key.startsWith("builtin:") && ALWAYS_ALLOW_REFUSED_BUILTINS.has(key.slice("builtin:".length));

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
    /**
     * Headless only: an `ask` tool stays (with an approval request) instead of being removed, because the run pauses
     * and its owner answers in a conversation (a sub-agent child, `sub-agents/execute.ts`). Device tools and the tools
     * that need a person's own input are still removed.
     */
    headlessCanAsk?: boolean;
    /**
     * The user's opt-in quick check (`low-risk-approval.ts`). Given, an `ask` tool that is eligible for it asks the check
     * before pausing: `true` runs the call unasked, anything else pauses as before. Omitted (the setting is off, or the
     * run is not one a person is in), every `ask` tool pauses exactly as it always did.
     */
    lowRiskCheck?: LowRiskCheck;
    /** The servers the user trusts to have their tools put to the quick check (`low-risk-trust.ts`). Absent: none. */
    lowRiskTrusted?: ReadonlySet<string>;
    /** The instant the grants are judged at. Defaults to the clock. */
    now?: number;
    /**
     * The broadest mode any run in this organization may give a tool (`org-policy.md` §6a). Absent: no cap (`auto`).
     * A tool above it is held at it. Below `auto` nothing lifts an `ask` (a grant, the quick check, a headless
     * inheritance), and device tools are removed: their approvals live on the member's computer.
     */
    permissionCap?: ToolPermissionMode;
    /**
     * The thread's permission mode (`thread-permission-mode.ts`). Absent is `auto`, today's behaviour. Ignored by a headless run.
     * See {@link threadModeDefault} for what each value does.
     */
    threadMode?: ThreadPermissionMode;
    /**
     * The user's time-boxed allows (`tool-permission-grants.ts`). They turn an `ask` into an `auto` for an interactive run only: a
     * headless run inherits nothing, and `off` stays off.
     */
    timedGrants?: ToolPermissionGrants;
    /**
     * Headless only: the mode of the bot the run belongs to (`bots.permissionMode`). Nobody is there to widen anything, so it
     * applies only when it asks MORE than the headless defaults: `supervised` moves a default as it does in a chat, and its
     * `ask` then meets the headless clamp below (removed, or paused when `headlessCanAsk`). `auto` and `full` change nothing.
     */
    unattendedMode?: ThreadPermissionMode;
}

export interface ResolvedToolPermission {
    mode: ToolPermissionMode;
    /** Set when `mode` is `auto` only because a time-boxed allow covers the tool until then. */
    timedUntil?: number;
}

/**
 * The tool's default as the thread's mode moves it. Applied to the DEFAULT only (see {@link resolveToolPermissionWithGrant}).
 *
 * - `supervised`: a tool that would run asks, unless it is a built-in read-only lookup. A third-party tool's read-only hint is
 *   the server's own word, so it asks too.
 * - `full`: a tool that would ask runs, unless it waits for a person.
 * - `auto` / absent: the default unchanged.
 * Device tools are approved on the device itself and keep their default in every mode. Only built-ins are classed read-only
 * by name; a third-party tool that defaults to `auto` already declared itself read-only.
 */
const threadModeDefault = (
    chosen: ToolPermissionMode,
    descriptor: ToolDescriptor,
    builtinName: string | undefined,
    threadMode: ThreadPermissionMode | undefined,
): ToolPermissionMode => {
    if (descriptor.source === "device" || threadMode === undefined || threadMode === "auto") {
        return chosen;
    }

    if (threadMode === "full") {
        const needsPerson = builtinName !== undefined && BUILTIN_TOOLS_NEEDING_A_PERSON.has(builtinName);

        return chosen === "ask" && !needsPerson ? "auto" : chosen;
    }

    if (chosen !== "auto") {
        return chosen;
    }

    // A third-party tool's read-only hint is the server's own word, so under supervised it asks like any other tool.
    if (builtinName === undefined) {
        return "ask";
    }

    return BUILTIN_TOOLS_READ_ONLY.has(builtinName) ? chosen : "ask";
};

/**
 * Effective mode for one tool: override, else default (moved by the thread's mode), then the headless clamp.
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
    const cap = options.permissionCap ?? "auto";
    const override = overrides?.[descriptor.key];
    const builtinName = descriptor.source === "builtin" ? descriptor.key.slice("builtin:".length) : undefined;
    // Precedence: a mode the user set for THIS tool wins over the thread's mode in both directions ("Always allow" is not
    // taken back by `supervised`, a chosen `ask` is not lifted by `full`); the thread's mode moves only the default. A
    // headless run ignores it: nobody is there, and its own clamp below decides. The organization's cap then clamps
    // whichever was chosen, so neither an override nor `full` lifts a tool above it, and everything below (grants,
    // headless, the origin clamp) reads the clamped mode. A headless run takes only a bot's `supervised` (`unattendedMode`).
    const headlessMode = options.unattendedMode === "supervised" ? "supervised" : undefined;
    const modeForDefault = options.headless ? headlessMode : options.threadMode;
    let chosen = clampToolPermission(
        isToolPermissionMode(override)
            ? override
            : threadModeDefault(defaultToolPermission(descriptor.source, descriptor.annotations, builtinName), descriptor, builtinName, modeForDefault),
        cap,
    );
    let timedUntil: number | undefined;

    // Before the origin clamp below, so an outside agent's grant-lifted tool is still `ask`. A grant lifts to `auto`, so it needs `auto` under the cap.
    if (chosen === "ask" && cap === "auto" && !options.headless && descriptor.source !== "device") {
        timedUntil = grantExpiryFor(options.timedGrants, descriptor.key, options.now ?? Date.now());

        if (timedUntil !== undefined) {
            chosen = "auto";
        }
    }

    if (cap !== "auto" && descriptor.source === "device") {
        return { mode: "off" };
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
        // An inherited consent lifts to `auto`, so it needs `auto` under the cap.
        if (cap === "auto" && builtinName !== undefined && options.headlessApproved?.has(builtinName)) {
            return { mode: "auto" };
        }

        return { mode: options.headlessCanAsk ? "ask" : "off" };
    }

    return { mode };
};

/** Reads MCP annotations off an `@ai-sdk/mcp` tool (`metadata.annotations`). */
export const readMcpAnnotations = (tool: unknown): ToolAnnotationHints | undefined =>
    (tool as { metadata?: { annotations?: ToolAnnotationHints } } | undefined)?.metadata?.annotations;

type OwnApproval = ToolSet[string]["needsApproval"];

interface NeedsApprovalOptions {
    messages?: ReadonlyArray<unknown>;
    toolCallId: string;
}

type AfterLapse = (input: unknown, options: NeedsApprovalOptions) => boolean | Promise<boolean>;

/** A `needsApproval` that asks, unless the quick check clears the call. It never throws: a check that fails asks. */
const needsApprovalUnless =
    (check: LowRiskCheck, { key, trustId }: ToolDescriptor) =>
    async (input: unknown, { messages, toolCallId }: NeedsApprovalOptions): Promise<boolean> => {
        try {
            return !(await check({ input, key, messages, toolCallId, ...(trustId !== undefined && { trustId }) }));
        } catch {
            return true;
        }
    };

/**
 * An `ask` tool that reads its target before it asks (`looksBeforeAsk`, the browser's clicks): its own `needsApproval` runs with
 * `asking` set, so its read is kept for the approved click, and the call always asks. A read that throws still asks; its
 * empty record then refuses the approved click.
 */
const askAfterLook = (own: OwnApproval): OwnApproval =>
    async function needsApprovalAfterLook(this: unknown, input: unknown, options: NeedsApprovalOptions): Promise<boolean> {
        try {
            if (typeof own === "function") {
                await (own as (this: unknown, input: unknown, options: unknown) => unknown).call(this, input, { ...options, asking: true });
            }
        } catch {
            // The read failed: the call still asks, and its record stays empty.
        }

        // Always asks. A call whose preread skipped the look (no action budget then) must not reach `execute` unapproved: a budget
        // freed before `execute` would let an ordinary-looking click run that nobody approved. The approval is then refused at
        // `execute` (no record), which fails closed.
        return true;
    } as OwnApproval;

/**
 * A timed allow's check: once the grant has lapsed the call asks (unless the quick check clears it), and it still asks
 * whenever the tool's own check does. A tool can decide per call that a person must click (a message to a worker on a
 * computer), and neither a grant nor the quick check lifts that.
 */
const withLapse = (own: OwnApproval, expiresAt: number, afterLapse: AfterLapse): OwnApproval => {
    if (own === true) {
        return true;
    }

    const lapsed = (input: unknown, options: NeedsApprovalOptions): boolean | Promise<boolean> => Date.now() >= expiresAt && afterLapse(input, options);

    if (typeof own !== "function") {
        return lapsed as OwnApproval;
    }

    return function needsApprovalOrLapsed(this: unknown, input: never, options: never) {
        // A call made after the lapse asks, so the tool's own check is asked as an ask is (`asking`): its decision keeps the
        // target it reads, and the approved click is checked against it. A call inside the grant is looked at as before.
        const isLapsed = Date.now() >= expiresAt;
        const ownOptions = isLapsed ? ({ ...(options as NeedsApprovalOptions), asking: true } as never) : options;
        const ownAnswer = (own as (this: unknown, input: never, options: never) => boolean | Promise<boolean>).call(this, input, ownOptions);
        // The grant can run out during the tool's own check (a renderer read takes seconds). A check that started inside the grant
        // ran without asking, so it recorded nothing: it runs again, asking, so the approved click has a target to be checked against.
        const settle = async (asked: boolean): Promise<boolean> => {
            if (asked) {
                return true;
            }

            const isLapsedNow = await lapsed(input, options);

            if (isLapsedNow && !isLapsed) {
                try {
                    await (own as (this: unknown, input: never, options: never) => unknown).call(this, input, {
                        ...(options as NeedsApprovalOptions),
                        asking: true,
                    } as never);
                } catch {
                    // The look failed: the call still asks, and its record stays empty.
                }
            }

            return isLapsedNow;
        };

        return typeof ownAnswer === "boolean" ? settle(ownAnswer) : ownAnswer.then(settle);
    } as unknown as OwnApproval;
};

/**
 * Apply permissions to a tool set.
 *
 * `describe` maps a runtime tool name to its descriptor; a tool it returns
 * `undefined` for is treated as a built-in keyed by its runtime name.
 *
 * `ask` tools are shallow-copied with `needsApproval: true` — or, when the user's opt-in quick check is on and the tool
 * is eligible for it (`low-risk-approval.ts`), with a `needsApproval` that asks the check first. Copying (rather than
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

        // Only a tool the user left at its default `ask` can be put to the quick check; the rules are in `low-risk-approval.ts`.
        // The quick check is an automatic approval, so it runs only where `auto` is allowed at all.
        const check =
            options.lowRiskCheck &&
            (options.permissionCap ?? "auto") === "auto" &&
            lowRiskIneligibleReason(descriptor, isToolPermissionMode(overrides?.[descriptor.key]), options) === null
                ? options.lowRiskCheck
                : undefined;

        if (mode === "ask") {
            requiresApproval.push(name);

            let askAnswer: OwnApproval = true;

            if (check) {
                askAnswer = needsApprovalUnless(check, descriptor);
            } else if ((tool as { looksBeforeAsk?: boolean }).looksBeforeAsk === true) {
                askAnswer = askAfterLook(tool.needsApproval);
            }

            result[name] = { ...tool, needsApproval: askAnswer } as ToolSet[string];
            continue;
        }

        // Tools are built once per run and a run can outlast the grant, so the lapse is checked at every call.
        if (timedUntil !== undefined) {
            const afterLapse: AfterLapse = check ? needsApprovalUnless(check, descriptor) : () => true;

            result[name] = { ...tool, needsApproval: withLapse(tool.needsApproval, timedUntil, afterLapse) } as ToolSet[string];
            continue;
        }

        result[name] = tool;
    }

    return { removed, requiresApproval, tools: result };
};
