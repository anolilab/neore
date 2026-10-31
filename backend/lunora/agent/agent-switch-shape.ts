/**
 * Reading a stored agent switch without the validators: no runtime import at all, so the browser can
 * read a divider row (the chat export does) without bundling `lunorash/server`. The writer and the
 * server-side readers validate with `agent-switch-validators.ts`; this only checks the shape.
 */
import type { AgentSwitchPart } from "./agent-switch-validators";

/** The `providerMetadata` key that marks a row as an agent switch. */
export const AGENT_SWITCH_KEY = "neoreAgentSwitch";

const SWITCH_MODES: ReadonlySet<unknown> = new Set(["delta", "full", "portable"]);

const isSwitchMode = (value: unknown): value is AgentSwitchPart["mode"] => SWITCH_MODES.has(value);

const isModelRef = (value: unknown): value is { kind: "model"; model: string } => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const { kind, model } = value as { kind?: unknown; model?: unknown };

    return kind === "model" && typeof model === "string";
};

/** The switch part a row carries when it has the stored shape, else `undefined`. */
export const readAgentSwitch = (row: { providerMetadata?: unknown }): AgentSwitchPart | undefined => {
    const stored = (row.providerMetadata as Record<string, unknown> | undefined)?.[AGENT_SWITCH_KEY];

    if (typeof stored !== "object" || stored === null) {
        return undefined;
    }

    const { from, mode, startMessageId, to } = stored as { from?: unknown; mode?: unknown; startMessageId?: unknown; to?: unknown };

    return isModelRef(from) && isModelRef(to) && isSwitchMode(mode) && typeof startMessageId === "string" ? { from, mode, startMessageId, to } : undefined;
};
