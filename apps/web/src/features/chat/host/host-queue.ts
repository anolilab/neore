/**
 * The rules for messages typed while a coding agent's turn runs (coding-workbench.md 2.3). The backend takes one prompt
 * at a time (`turn_running`), so the composer holds the rest and sends them in order, each once the previous turn's
 * stream has cleared. Pure, so the order and the pause rules are tested without rendering the composer.
 */

import type { CapabilityReport } from "@neore/ai/capabilities";
import { followUpControl } from "@neore/ai/capabilities";

/**
 * A host turn's follow-up. The stored report cannot say "restart", because the agent itself never accepts a prompt
 * during a turn: the composer ends the running turn and sends the queued text first, and it enforces that here, so
 * the declaration is ours (provider-capabilities.md §5, the static declarations). Never a model or agent name.
 */
const HOST_FOLLOW_UP_REPORT: CapabilityReport = {
    groups: { turns: { followUp: { degradation: "restart", kind: "steer" } } },
    reportedAt: 0,
    version: 1,
};

/** Whether the composer offers "Interrupt and send" (the restart steer), through the same gate every steer control uses. */
export const canInterruptAndSend = (): boolean => followUpControl(HOST_FOLLOW_UP_REPORT) === "steer-restart";

/**
 * A message typed now waits behind the queue when a turn runs, the last queued send is still starting its turn, or the
 * queue already holds messages. A send in flight takes no new message at all: the composer ignores Enter then, so one
 * text cannot be queued twice.
 */
export const shouldQueueMessage = (state: { pendingStart: boolean; queued: number; running: boolean }): boolean =>
    state.running || state.pendingStart || state.queued > 0;

/**
 * Whether the queue's head may be sent now. Never while a turn runs or its end is still being decided, while a send is in flight, while
 * the session is ended or starting, or while the queue is paused after a refusal. `pendingStart` holds the queue for the
 * stream of the send that just succeeded: the backend stores it at once, but the composer learns of it a moment later,
 * and sending the next message in that gap would be refused as `turn_running`.
 */
export const canSendQueueHead = (state: {
    blocked: boolean;
    held: boolean;
    loaded: boolean;
    paused: boolean;
    pendingStart: boolean;
    queued: number;
    running: boolean;
    sending: boolean;
    starting: boolean;
}): boolean =>
    state.queued > 0 &&
    state.loaded &&
    !state.paused &&
    !state.blocked &&
    !state.starting &&
    !state.held &&
    !state.running &&
    !state.sending &&
    !state.pendingStart;
