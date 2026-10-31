/**
 * What an agent told us at the handshake, as a capability report (`@neore/ai/capabilities`,
 * plans/provider-capabilities.md §5). Pure, and keyed by what the agent ADVERTISED, never by its name.
 *
 * Only the `sessions` members are mapped so far: they are the ones something here acts on (the import of an
 * agent's saved sessions). A member left out reads as `unknown`, which hides its control; reporting one nothing
 * here enforces would be worse than leaving it out.
 */
import type { CapabilityReport } from "@neore/ai/capabilities";

import type { AgentCapabilities } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const NATIVE = { degradation: "none", supported: true } as const;
const NOT_OFFERED = { reason: "not_offered", supported: false } as const;

/**
 * `loadSession` is a boolean; `sessionCapabilities.list` is "present means supported" (ACP: omitted or `null` is no
 * support, `{}` is support). The agent answered the handshake, so what it left out is not offered, not unknown.
 */
export const reportFromHandshake = (capabilities: AgentCapabilities, now: number): CapabilityReport => {
    const sessionCapabilities = isRecord(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};

    return {
        groups: {
            sessions: {
                listNative: isRecord(sessionCapabilities.list) ? NATIVE : NOT_OFFERED,
                load: capabilities.loadSession === true ? NATIVE : NOT_OFFERED,
            },
        },
        reportedAt: now,
        version: 1,
    };
};
