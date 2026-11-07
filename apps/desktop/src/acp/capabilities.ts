/**
 * What an agent told us at the handshake, as a capability report (`@neore/ai/capabilities`,
 * provider-capabilities.md §5). Pure, and keyed by what the agent ADVERTISED, never by its name.
 *
 * Only the `sessions` members are mapped so far: they are the ones something here acts on (the import of an
 * agent's saved sessions). A member left out reads as `unknown`, which hides its control; reporting one nothing
 * here enforces would be worse than leaving it out.
 */
import type { CapabilityReport } from "@neore/ai/capabilities";

import type { AgentOptions } from "./agent-options";
import type { AgentCapabilities } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const NATIVE = { degradation: "none", supported: true } as const;
const NOT_OFFERED = { reason: "not_offered", supported: false } as const;

/**
 * `loadSession` is a boolean; `sessionCapabilities.list` and `.fork` are "present means supported" (ACP: omitted or `null` is no
 * support, `{}` is support). The agent answered the handshake, so what it left out is not offered, not unknown.
 */
export const reportFromHandshake = (capabilities: AgentCapabilities, now: number): CapabilityReport => {
    const sessionCapabilities = isRecord(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};

    return {
        groups: {
            sessions: {
                fork: isRecord(sessionCapabilities.fork) ? NATIVE : NOT_OFFERED,
                listNative: isRecord(sessionCapabilities.list) ? NATIVE : NOT_OFFERED,
                load: capabilities.loadSession === true ? NATIVE : NOT_OFFERED,
            },
        },
        reportedAt: now,
        version: 1,
    };
};

const optionsIn = (options: AgentOptions, category: string) => (options.configOptions ?? []).filter((option) => option.category === category);

/** The report's own cap on the model list (`backend/lunora/lib/capability-report.ts`). */
const MAX_MODELS = 200;

/**
 * The options the agent offers for its session (`agent-options.ts`), added to its handshake report: the models it can run
 * (`identity.models`) and whether it has a reasoning-effort setting (`identity.reasoningEffort`). Read from the option's
 * category, never from the agent's or a model's name. Its modes (Plan, Build ...) are not permission modes the runner
 * enforces, so they are not reported as `permissions.modes`.
 */
export const withOptionCapabilities = (report: CapabilityReport, options: AgentOptions, now: number): CapabilityReport => {
    // Every model option's choices, each model once: an agent may file more than one option under `model`.
    const models = new Map<string, string>();

    for (const choice of optionsIn(options, "model").flatMap((option) => option.choices)) {
        if (!models.has(choice.value) && models.size < MAX_MODELS) {
            models.set(choice.value, choice.name);
        }
    }

    return {
        ...report,
        groups: {
            ...report.groups,
            identity: {
                ...report.groups.identity,
                models: [...models].map(([id, name]) => {
                    return { id, name };
                }),
                reasoningEffort: optionsIn(options, "thought_level").length === 0 ? NOT_OFFERED : NATIVE,
            },
        },
        reportedAt: now,
    };
};
