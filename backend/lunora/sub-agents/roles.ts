/**
 * Sub-agent roles — the pure rules. A role is a kind of delegated work (review, research, …) the user gave a model of
 * its own. The user sets roles for every chat; a project can override any field of any role. A role does nothing until
 * it has a model; then the lead's prompt lists it ({@link buildRoleCatalog}) and a `delegateToSubAgent` call that names
 * it runs on that model with the role's instructions ({@link resolveRoleLaunch}, {@link roleSystemText}).
 */
import { MODEL_LOOKUP } from "@neore/ai/models";
import type { Infer } from "lunorash/server";

import { withoutUndefined } from "../lib/patch";
import { isTaskModelAllowed } from "../tasks/logic";

import type { vSubAgentRoleConfig, vSubAgentRoleName, vSubAgentRoles, vSubAgentRunRole } from "./validators";

export type SubAgentRoleName = Infer<typeof vSubAgentRoleName>;
export type SubAgentRoleConfig = Infer<typeof vSubAgentRoleConfig>;
export type SubAgentRoles = Infer<typeof vSubAgentRoles>;
export type SubAgentRunRole = Infer<typeof vSubAgentRunRole>;

/** In the order the settings and the catalog list them. */
export const SUB_AGENT_ROLE_NAMES = [
    "architecture",
    "implementation",
    "research",
    "review",
    "security",
    "design",
    "test",
    "general",
] as const satisfies ReadonlyArray<SubAgentRoleName>;

/** Whether a role may run on `modelId`: the rule every sub-agent's model passes (`tasks/logic.ts:isTaskModelAllowed`). */
export const isRoleModelAllowed = (modelId: string): boolean => isTaskModelAllowed(modelId, (lookupId) => MODEL_LOOKUP.get(lookupId));

/** What work matches the role, as the lead's catalog states it. */
export const ROLE_SCOPES: Record<SubAgentRoleName, string> = {
    architecture: "designing a system or a change that spans several parts: boundaries, data flow, trade-offs, a plan",
    design: "user interface, user experience and visual design: layouts, flows, copy on screens, accessibility",
    general: "any other self-contained task that no role above covers",
    implementation: "writing or changing code, configuration or scripts",
    research: "finding, reading and comparing sources to answer a question",
    review: "checking code, a draft or a plan for mistakes and gaps",
    security: "security review: vulnerabilities, secrets, access control, threat models",
    test: "writing tests and checking that a change works as intended",
};

/** The standard each role works to, sent to the sub-agent ahead of the user's own instructions for the role. */
export const ROLE_INSTRUCTIONS: Record<SubAgentRoleName, string> = {
    architecture:
        "Start from what exists and the constraints in the task. Compare at most a few options, recommend one, and say what it costs and what would make you change your mind. Name the parts it touches and the order to change them in.",
    design: "Work from the people who will use it and what they are trying to do. Keep to the existing look and patterns unless the task asks for new ones. Cover empty, loading and error states, keyboard use and contrast.",
    general: "Do the task as asked and keep to its scope. Say what you assumed.",
    implementation:
        "Make the smallest change that does what the task asks, in the style of the code around it. Reuse what exists before adding anything. Say what you changed, what you checked and what you could not check.",
    research:
        "Prefer primary sources and say where each fact comes from. Separate what the sources say from your own reading of them. Say what you could not find or confirm, and how recent the sources are.",
    review: "Report problems, not praise. For each one give where it is, what goes wrong and in what situation, and how sure you are. Put the most serious first, and say plainly when you found nothing.",
    security:
        "Look for ways the work can be abused: untrusted input, missing access checks, leaked secrets, unsafe defaults. For each finding give how it is reached, what an attacker gains and the fix. Do not run anything destructive.",
    test: "Test the behaviour the task cares about, including edge cases and failure paths, not the implementation details. Say what each test proves and what is still untested.",
};

const ROLE_INSTRUCTIONS_MAX = 4000;

/** The fields a scope actually set; an absent one must not shadow the scope below it. */
const setFields = (config: SubAgentRoleConfig | undefined): SubAgentRoleConfig => withoutUndefined(config ?? {}) as SubAgentRoleConfig;

/**
 * The roles in effect: each field of a project's role wins over the user's, which wins over nothing. A field the
 * project leaves out inherits, so a project can change one role's model and keep the user's instructions for it.
 */
export const mergeSubAgentRoles = (user: SubAgentRoles | undefined, project: SubAgentRoles | undefined): SubAgentRoles => {
    const merged: SubAgentRoles = {};

    for (const name of SUB_AGENT_ROLE_NAMES) {
        const fields: SubAgentRoleConfig = { ...setFields(user?.[name]), ...setFields(project?.[name]) };

        if (Object.keys(fields).length > 0) {
            merged[name] = fields;
        }
    }

    return merged;
};

/** The roles that are on: those with a model. Instructions or a mode alone turn nothing on. */
export const activeRoles = (roles: SubAgentRoles): SubAgentRoleName[] => SUB_AGENT_ROLE_NAMES.filter((name) => Boolean(roles[name]?.model));

/**
 * The lead's catalog of the roles that are on, or `undefined` when none is. It names roles, scopes and modes only —
 * never a role's instructions, which are the user's own text and go to the sub-agent alone.
 */
export const buildRoleCatalog = (roles: SubAgentRoles): string | undefined => {
    const active = activeRoles(roles);

    if (active.length === 0) {
        return undefined;
    }

    const lines = active.map((name) => `- ${name} (${roles[name]?.mode ?? "prefer"}): ${ROLE_SCOPES[name]}`);

    return `SUB-AGENT ROLES:
The user chose a model for these kinds of work. When the request calls for one of them, hand that part to delegateToSubAgent with \`role\` set, so it runs on the user's model for it:
${lines.join("\n")}
"prefer": delegate substantial, self-contained work of that kind; answer quick questions and make small, contained changes yourself.
"always": every real piece of that kind of work goes to the role, even when you could do it quickly yourself. A passing mention or a quick question about it is not that work.
If the user asks you to do the work yourself, do it here instead. Use only the roles listed above.`;
};

const runRoleOf = (config: SubAgentRoleConfig, name: SubAgentRoleName): SubAgentRunRole => {
    return {
        ...(config.instructions?.trim() && { instructions: config.instructions.slice(0, ROLE_INSTRUCTIONS_MAX) }),
        ...(config.model && { model: config.model }),
        name,
        ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
    };
};

/**
 * What a call naming `name` launches with, or why it cannot launch. A role without a model, or whose model the task
 * rule refuses, is an error for the lead to read: nothing falls back to another model quietly.
 */
export const resolveRoleLaunch = (
    roles: SubAgentRoles,
    name: SubAgentRoleName,
    isAllowed: (modelId: string) => boolean,
): { error: string } | { role: SubAgentRunRole & { model: string } } => {
    const config = roles[name];

    if (!config?.model) {
        return { error: `The ${name} role has no model set. Delegate without a role, or ask the user to set one in Settings → Sub-agent roles.` };
    }

    if (!isAllowed(config.model)) {
        return {
            error: `The ${name} role's model (${config.model}) cannot run sub-agents. Delegate without a role, or ask the user to pick another model for it in Settings → Sub-agent roles.`,
        };
    }

    return { role: { ...runRoleOf(config, name), model: config.model } };
};

/**
 * What a worker on a computer launches with: the role's instructions, whatever its model. That worker runs on its
 * coding agent, so neither a missing model nor one this user cannot run stops it.
 */
export const resolveHostRoleLaunch = (roles: SubAgentRoles, name: SubAgentRoleName): { role: SubAgentRunRole } => {
    return { role: runRoleOf(roles[name] ?? {}, name) };
};

/** The block a role adds to the sub-agent's system text: the built-in standard, then the user's own instructions. */
export const roleSystemText = (role: SubAgentRunRole): string => {
    const parts = [`ROLE: ${role.name}\n${ROLE_INSTRUCTIONS[role.name]}`];

    if (role.instructions) {
        // A project's owner wrote these, not the user: the agent must not take them for the user's own word.
        const header =
            role.instructionsBy === "projectOwner"
                ? "THE PROJECT OWNER'S INSTRUCTIONS FOR THIS ROLE (set for the project by its owner, not by the user):"
                : "THE USER'S INSTRUCTIONS FOR THIS ROLE:";

        parts.push(`${header}\n${role.instructions}`);
    }

    return parts.join("\n\n");
};

/** `roles` with one role replaced, or removed for `null`; an empty result is `{}`, never `undefined`, so a patch keeps it. */
export const withRole = (roles: SubAgentRoles | undefined, name: SubAgentRoleName, config: SubAgentRoleConfig | null): SubAgentRoles => {
    const next: SubAgentRoles = { ...roles };

    if (config === null || Object.values(config).every((value) => value === undefined)) {
        delete next[name];
    } else {
        next[name] = config;
    }

    return next;
};
