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

const HOST_TEXT_FIELDS = ["agentKey", "agentLabel", "folderId", "folderLabel", "hostId"] as const;

const isAgentRef = (value: unknown): value is AgentSwitchPart["from"] => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const fields = value as Record<string, unknown>;

    if (fields.kind === "model") {
        return typeof fields.model === "string";
    }

    return fields.kind === "host" && HOST_TEXT_FIELDS.every((key) => typeof fields[key] === "string");
};

/** The switch part a row carries when it has the stored shape, else `undefined`. */
export const readAgentSwitch = (row: { providerMetadata?: unknown }): AgentSwitchPart | undefined => {
    const stored = (row.providerMetadata as Record<string, unknown> | undefined)?.[AGENT_SWITCH_KEY];

    if (typeof stored !== "object" || stored === null) {
        return undefined;
    }

    const { from, mode, startMessageId, to } = stored as { from?: unknown; mode?: unknown; startMessageId?: unknown; to?: unknown };

    return isAgentRef(from) && isAgentRef(to) && isSwitchMode(mode) && typeof startMessageId === "string" ? { from, mode, startMessageId, to } : undefined;
};

/** The name a divider shows for an agent: the model's name (looked up by the caller), or the coding agent and its folder. */
export const switchAgentName = (agent: AgentSwitchPart["from"], modelName: (model: string) => string): string =>
    agent.kind === "model" ? modelName(agent.model) : `${agent.agentLabel} · ${agent.folderLabel}`;
