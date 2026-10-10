/**
 * "Generate from description" for the skill editor — an agent-builder lite.
 *
 * The user describes a goal; the model drafts the skill's fields and the editor
 * pre-fills its form with them. Nothing is persisted here: the user reviews the
 * draft and saves it through `createSkill`, which applies its own validation and
 * limits. `agent-creation.ts` is the in-chat counterpart that DOES persist, and
 * is deliberately not reused — a draft the user has not reviewed must not count
 * against their skill limit or land in their list.
 */
import { DEFAULT_PROMPT_IMPROVEMENT_MODEL } from "@neore/ai/constants";
import type { LanguageModel } from "ai";
import { generateText, Output } from "ai";
import { LunoraError, v } from "lunorash/server";
import z from "zod/v4";

import getAgent from "../chat/lib/get-agent";
import { authAction, rateLimit } from "../lib/crpc";
import { gatewayFetch } from "../lib/services";
import { buildSkillGeneratorPrompt, MAX_GOAL_LENGTH, normalizeSkillDraft } from "./generate-prompt";
import { getToolRegistry } from "./jit-tool-loader";
import { MAX_LENGTH } from "../lib/validators";

const rawDraftSchema = z.object({
    additionalTools: z.array(z.string()).optional(),
    category: z.string().optional(),
    description: z.string(),
    instructions: z.string(),
    name: z.string(),
    slug: z.string(),
    tags: z.array(z.string()).optional(),
    variables: z
        .array(
            z.object({
                defaultValue: z.string().optional(),
                description: z.string().optional(),
                name: z.string(),
                required: z.boolean().optional(),
            }),
        )
        .optional(),
});

const vSkillDraft = v.object({
    additionalTools: v.array(v.string()),
    category: v.optional(v.string()),
    description: v.string(),
    instructions: v.string(),
    name: v.string(),
    slug: v.string(),
    tags: v.array(v.string()),
    variables: v.array(
        v.object({
            defaultValue: v.optional(v.string()),
            description: v.optional(v.string()),
            name: v.string(),
            required: v.optional(v.boolean()),
        }),
    ),
});

/**
 * Draft a skill from a natural-language goal. Shares the
 * `chat/promptImprovement` budget with the prompt optimizer: both are
 * single-shot, user-triggered "rewrite my text" calls.
 */
export const generateSkillDraft = authAction
    .use(rateLimit("chat/promptImprovement"))
    .input({
        goal: v.string().max(MAX_LENGTH.text),
    })
    .output(vSkillDraft)
    .action(async ({ args: { goal }, ctx }) => {
        const trimmed = goal.trim();

        if (trimmed.length < 10) {
            throw new LunoraError("BAD_REQUEST", "Describe the skill in at least a few words");
        }

        if (trimmed.length > MAX_GOAL_LENGTH) {
            throw new LunoraError("BAD_REQUEST", `Keep the description under ${MAX_GOAL_LENGTH} characters`);
        }

        // `getAgent` wraps the model in the LLM gateway (and refuses to run without
        // one), so this call is metered and attributed like every other.
        const agent = await getAgent(DEFAULT_PROMPT_IMPROVEMENT_MODEL, { gateway: gatewayFetch(ctx), userId: ctx.user.userId });

        const tools = getToolRegistry();
        const { prompt, system } = buildSkillGeneratorPrompt(trimmed, tools);

        const result = await generateText({
            maxOutputTokens: 4000,
            model: agent.options.languageModel as LanguageModel,
            output: Output.object({ schema: rawDraftSchema }),
            prompt,
            system,
            temperature: 0.4,
        });

        const draft = normalizeSkillDraft(result.output, new Set(tools.map((tool) => tool.name)));

        ctx.log.event("skills.generate_draft", {
            inputTokens: result.usage.inputTokens,
            model: DEFAULT_PROMPT_IMPROVEMENT_MODEL,
            outputTokens: result.usage.outputTokens,
            toolCount: tools.length,
        });

        return draft;
    });
