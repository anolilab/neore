/**
 * The pure half of a thread's agent switch: how the switch is stored on a message row, and
 * how a row is read back. A switch is one `system` row with no text, so no model ever sees
 * it, and the transcript shows it as a divider. Its payload rides in `providerMetadata`,
 * which already holds opaque per-row facts (`neoreJob`) and is nobody's model input.
 */
import { type AgentRef, type AgentSwitchPart, vAgentSwitch } from "./agent-switch-validators";

import { AGENT_SWITCH_KEY } from "./agent-switch-shape";

/** The part a row carries, or `undefined` for every other row (and for a part that does not check). */
export const agentSwitchOf = (row: { providerMetadata?: unknown }): AgentSwitchPart | undefined => {
    const metadata = row.providerMetadata as Record<string, unknown> | undefined;
    const stored = metadata?.[AGENT_SWITCH_KEY];

    if (stored === undefined) {
        return undefined;
    }

    const parsed = vAgentSwitch.safeParse(stored);

    return parsed.ok ? parsed.value : undefined;
};

/** The `message` and `providerMetadata` of the row that records `part`. Throws on a part that does not check. */
export const agentSwitchRowContent = (
    part: AgentSwitchPart,
): { message: { content: string; role: "system" }; providerMetadata: Record<string, Record<string, unknown>> } => {
    const checked = vAgentSwitch.parse(part);

    return { message: { content: "", role: "system" }, providerMetadata: { [AGENT_SWITCH_KEY]: checked } };
};

export const sameAgent = (a: AgentRef, b: AgentRef): boolean => a.kind === b.kind && a.model === b.model;

/** The newest switch among `rows` (newest first, as a path walk returns them), if any. */
export const lastAgentSwitch = (rows: ReadonlyArray<{ providerMetadata?: unknown }>): AgentSwitchPart | undefined =>
    rows.map((row) => agentSwitchOf(row)).find((part) => part !== undefined);

export { AGENT_SWITCH_KEY } from "./agent-switch-shape";
