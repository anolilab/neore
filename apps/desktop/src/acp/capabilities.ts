/**
 * What an agent told us at the handshake, as a capability report (`@neore/ai/capabilities`,
 * provider-capabilities.md §5). Pure, and keyed by what the agent ADVERTISED, never by its name.
 *
 * Only the `sessions` members are mapped from the handshake: they are the ones something here acts on (the import of
 * an agent's saved sessions). The options the agent offers are known only once it has opened a session, and are added
 * by {@link withOptionCapabilities}. A member left out reads as `unknown`, which hides its control; reporting one
 * nothing here enforces would be worse than leaving it out.
 */
import type { CapabilityReport } from "@neore/ai/capabilities";

import type { SessionStatePatch } from "./host-events";
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

/** The first option the agent filed under a category, if it sent any. */
const optionIn = (options: SessionStatePatch, category: string) => options.configOptions?.find((option) => option.category === category);

/**
 * What the agent offered when it opened the session (`agent-options.ts#resolveOptions`), added to its handshake report: the
 * models it can run (`identity.models`) and whether it has a reasoning-effort setting (`identity.reasoningEffort`). Only a
 * model option counts as a selectable model, since only an option can be changed (`acp_set_config`); the legacy model list
 * is read-only and reports none. The agent's session modes (Plan, Build ...) are not permission modes the runner enforces,
 * so they are not reported as `permissions.modes`. Read from the option's category, never from the agent's or a model's name.
 */
export const withOptionCapabilities = (report: CapabilityReport, options: SessionStatePatch): CapabilityReport => {
    const model = optionIn(options, "model");
    const models = model === undefined
        ? []
        : model.choices.map((choice) => {
            return { id: choice.value, name: choice.name };
        });

    return {
        ...report,
        groups: {
            ...report.groups,
            identity: {
                ...report.groups.identity,
                models,
                reasoningEffort: optionIn(options, "thought_level") === undefined ? NOT_OFFERED : NATIVE,
            },
        },
    };
};
