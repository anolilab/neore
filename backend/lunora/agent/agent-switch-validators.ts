/**
 * Validators for a thread's agent switch — the `threads.activeAgent` column and the
 * `agentSwitch` part a switch leaves in the transcript (`agent/agent-switch.ts`).
 *
 * Imported by `schema.ts`, so this module must stay free of runtime imports beyond `../lib/validators` and
 * `lunorash/server`.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { MAX_LENGTH } from "../lib/validators";

/** A cloud model: what `threads.activeAgent` caches. A host agent never does; a host thread's agent is its session's. */
export const vAgentRef = v.object({
    kind: v.literal("model"),
    model: v.string().max(MAX_LENGTH.short),
});

export type AgentRef = Infer<typeof vAgentRef>;

/**
 * A coding agent on a paired computer, in one folder: the triple a session is bound to, plus the two labels the
 * divider shows (never a path or a command line, which stay on the desktop).
 */
export const vHostAgentRef = v.object({
    agentKey: v.string().max(128),
    agentLabel: v.string().max(MAX_LENGTH.short),
    folderId: v.string().max(128),
    folderLabel: v.string().max(MAX_LENGTH.short),
    hostId: v.string().max(MAX_LENGTH.id),
    kind: v.literal("host"),
});

export type HostAgentRef = Infer<typeof vHostAgentRef>;

/** Either side of a divider: a cloud model or a host agent. */
export const vSwitchAgentRef = v.union(vAgentRef, vHostAgentRef);

export type SwitchAgentRef = Infer<typeof vSwitchAgentRef>;

/**
 * What the new agent was given. `full`: the whole active path, as before the switch.
 * `portable`: the stored handoff in place of everything before the divider. `delta`: what the agent
 * saw before it left, then the stored handoff of what happened since, then the turns after. `native`: the same coding
 * agent loads its own saved session (harness switch S4); the portable handoff is stored too, for the fallback.
 */
export const vAgentSwitchMode = v.union(v.literal("full"), v.literal("portable"), v.literal("delta"), v.literal("native"));

/**
 * Longest handoff a divider may store, in characters. The budget (`agent/handoff.ts`) is far below it;
 * this is only the bound a reader can trust.
 */
export const HANDOFF_MAX_CHARACTERS = 80_000;

/**
 * The part a switch writes. `startMessageId` is the row the switch follows, where a
 * handoff starts counting from. `handoff` is the text the new agent receives, built once and
 * stored here so every later turn sends the same bytes; `summarized` says it holds a model's
 * summary of older turns, for the divider's note.
 */
export const vAgentSwitch = v.object({
    // Why a `native` reattach became `portable`: the agent could not load its saved session.
    fallbackReason: v.optional(v.string().max(500)),
    from: vSwitchAgentRef,
    handoff: v.optional(v.string().max(HANDOFF_MAX_CHARACTERS)),
    mode: vAgentSwitchMode,
    startMessageId: v.string().max(MAX_LENGTH.id),
    summarized: v.optional(v.boolean()),
    to: vSwitchAgentRef,
});

export type AgentSwitchPart = Infer<typeof vAgentSwitch>;
