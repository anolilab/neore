/**
 * Whether the window offers to import an agent's saved sessions. The answer comes from the capability report the
 * agent gave at its last handshake, through the shared rules (`@neore/ai/capabilities`), and from nothing else:
 * never the agent's name. No report (the agent has not been started since this app began), an `unknown` member or a
 * member the agent does not offer hides the control. The main process checks again before it sends a frame.
 */
import type { CapabilityReport } from "@neore/ai/capabilities";
import { capabilityOf, isAvailable } from "@neore/ai/capabilities";

/** Both are needed: listing is how a session is chosen, loading is how its history is read. */
export const canImportSessions = (report: CapabilityReport | null | undefined): boolean =>
    isAvailable(capabilityOf(report, "sessions.listNative")) && isAvailable(capabilityOf(report, "sessions.load"));
