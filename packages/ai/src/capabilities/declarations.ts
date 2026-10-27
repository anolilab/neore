/**
 * What the runners Neore itself provides can do, declared in code. Keyed by the
 * KIND of runner, never by a model or agent name, and computed rather than stored.
 * A host runner's report comes from the runner at session start instead.
 *
 * Only what the runner enforces is listed. A member left out reads as `unknown`,
 * which hides its control; claiming one the runner ignores would be worse.
 * `reportedAt` is 0: a declaration is never "reported", so there is no age to show.
 */
import type { CapabilityReport } from "./types";

const NATIVE = { degradation: "none", supported: true } as const;

/**
 * `runStreamingAgent` and `continueAfterToolApproval`: a run with a persistent stream.
 * Forking (`branchThread`) is a thread action, not a runner capability, so §4 has no member for it.
 */
export const CLOUD_INTERACTIVE_CAPABILITIES: CapabilityReport = {
    groups: {
        // Live chunks carry text and reasoning only; a tool part arrives with its saved step.
        streaming: { reasoning: NATIVE, text: NATIVE },
        // `respondToToolApproval` takes approve, always and deny; a deny resumes the run.
        tools: { approvalRequest: NATIVE, call: NATIVE, declinePath: NATIVE },
        // Stop in `chat/functions.ts`; `steerRun` queues into the running stream at a step boundary.
        turns: { cancel: NATIVE, followUp: { kind: "steer" } },
    },
    reportedAt: 0,
    version: 1,
};

/**
 * `runHeadlessAgent` as `subAgentRuns` drive it (sub-agent and worker runs). No persistent
 * stream, so nothing can be steered into a run: a follow-up waits for it to end. Not for
 * the other headless callers (triggers, tasks, evals, messenger replies): they pass no
 * `shouldStop`, so `cancel` would not hold for them.
 */
export const CLOUD_HEADLESS_CAPABILITIES: CapabilityReport = {
    groups: {
        // `cancelSubAgentRun`.
        turns: { cancel: NATIVE, followUp: { kind: "queue" } },
    },
    reportedAt: 0,
    version: 1,
};

/** `chat/local-models.ts`: the browser calls the loopback server and the backend saves text only. */
export const LOCAL_BROWSER_CAPABILITIES: CapabilityReport = {
    groups: {
        streaming: { text: NATIVE },
        // The browser aborts its own request; the composer holds a prompt sent mid-stream and sends it after.
        turns: { cancel: NATIVE, followUp: { kind: "queue" } },
    },
    reportedAt: 0,
    version: 1,
};
