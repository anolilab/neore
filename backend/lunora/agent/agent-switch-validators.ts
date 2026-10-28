/**
 * Validators for a thread's agent switch — the `threads.activeAgent` column and the
 * `agentSwitch` part a switch leaves in the transcript (`agent/agent-switch.ts`).
 *
 * Imported by `schema.ts`, so this module must stay free of runtime imports beyond
 * `lunorash/server`.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

/** A cloud model. The host variant `{ kind: "host", … }` joins this union with host switches. */
export const vAgentRef = v.object({
    kind: v.literal("model"),
    model: v.string(),
});

export type AgentRef = Infer<typeof vAgentRef>;

/**
 * What the new agent was given. `full`: the whole active path, as before the switch.
 * `portable`: the stored handoff in place of everything before the divider. `delta`: what the agent
 * saw before it left, then the stored handoff of what happened since, then the turns after.
 */
export const vAgentSwitchMode = v.union(v.literal("full"), v.literal("portable"), v.literal("delta"));

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
    from: vAgentRef,
    handoff: v.optional(v.string().max(HANDOFF_MAX_CHARACTERS)),
    mode: vAgentSwitchMode,
    startMessageId: v.string(),
    summarized: v.optional(v.boolean()),
    to: vAgentRef,
});

export type AgentSwitchPart = Infer<typeof vAgentSwitch>;
