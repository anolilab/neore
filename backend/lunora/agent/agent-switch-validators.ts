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
 * Handoff modes (`portable`, `delta`, …) join it with the handoff itself.
 */
export const vAgentSwitchMode = v.literal("full");

/**
 * The part a switch writes. `startMessageId` is the row the switch follows, where a
 * handoff would start counting from.
 */
export const vAgentSwitch = v.object({
    from: vAgentRef,
    mode: vAgentSwitchMode,
    startMessageId: v.string(),
    to: vAgentRef,
});

export type AgentSwitchPart = Infer<typeof vAgentSwitch>;
