/**
 * The guided Agent Builder — the conversational successor to `generate.ts`'s
 * single-shot draft.
 *
 * 1. `runBuilderTurn`: the user describes a goal; the model either asks up to
 *    three clarifying questions or proposes a complete draft (instructions,
 *    model, search mode, reasoning effort, tools) plus recommendations — remote
 *    MCP servers from the official registry, OAuth connectors by id, and public
 *    marketplace skills that already fit.
 * 2. `refineBuilderDraft`: a follow-up instruction regenerates only the fields
 *    it affects; the client renders the diff.
 * 3. `attachSkillTestDrive`: runs the unsaved draft in a temporary thread
 *    through the ordinary chat pipeline (see `resolveSkillsForRun`).
 *
 * Nothing here installs, enables or persists a skill. Saving goes through
 * `createSkill`; an MCP recommendation becomes a prefilled add-server form the
 * user confirms. Every model-proposed name is whitelisted in `builder-logic.ts`.
 */
import { DEFAULT_PROMPT_IMPROVEMENT_MODEL } from "@neore/ai/constants";
import { MODEL_REGISTRY } from "@neore/ai/models";
import { generateText, Output } from "ai";
import { LunoraError, v } from "lunorash/server";
import z from "zod/v4";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { patchTemporaryThread } from "../agent/table-writes";
import { getEnabledSearchModes } from "../chat/lib/tool-builder";
import { fetchCachedRegistryPage } from "../chat/mcp-registry";
import { authAction, authMutation, rateLimit } from "../lib/crpc";
import { logger } from "../lib/logger";
import { gatewayFetch, type ServiceFetch } from "../lib/services";
import { getUtilityModel } from "../lib/utility-model";
import type { BuilderDraft, BuilderWhitelist, RawBuilderDraft, RawBuilderResponse } from "./builder-logic";
import {
    applyRefinement,
    BuilderOutputError,
    buildBuilderTurnPrompt,
    buildRefinePrompt,
    MAX_ANSWER_LENGTH,
    MAX_CLARIFYING_QUESTIONS,
    MAX_GOAL_LENGTH,
    MAX_REFINE_INSTRUCTION_LENGTH,
    parseBuilderResponse,
    resolveDraftInstructions,
    sanitizeRunConfig,
    selectableTextModels,
} from "./builder-logic";
import { MAX_INSTRUCTIONS_LENGTH } from "./generate-prompt";
import { getToolRegistry } from "./jit-tool-loader";
import { searchMarketplaceSkills } from "./marketplace";
import { vSkillConfig } from "./validators";
import { MAX_LENGTH } from "../lib/validators";

const MCP_SERVERS_PER_SEARCH = 2;
const MARKETPLACE_SKILLS_PER_QUERY = 3;
const MAX_MARKETPLACE_RECOMMENDATIONS = 4;

// ============================================================================
// Whitelist
// ============================================================================

let cachedWhitelist: BuilderWhitelist | undefined;

const getWhitelist = (): BuilderWhitelist => {
    cachedWhitelist ??= {
        models: selectableTextModels(MODEL_REGISTRY),
        searchModes: getEnabledSearchModes().map((mode) => {
            return { description: mode.description, id: mode.id };
        }),
        tools: getToolRegistry(),
    };

    return cachedWhitelist;
};

// ============================================================================
// Validators
// ============================================================================

const vBuilderDraft = v.object({
    category: v.optional(v.string()),
    description: v.string(),
    disableTools: v.array(v.object({ name: v.string(), reason: v.string() })),
    enableTools: v.array(v.object({ name: v.string(), reason: v.string() })),
    instructions: v.string(),
    name: v.string(),
    preferredModel: v.optional(v.object({ id: v.string(), name: v.string(), reason: v.string() })),
    reasoningEffort: v.optional(v.object({ reason: v.string(), value: v.number() })),
    searchMode: v.optional(v.object({ id: v.string(), reason: v.string() })),
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

const vRegistryInput = v.object({
    choices: v.optional(v.array(v.string())),
    description: v.optional(v.string()),
    isRequired: v.boolean(),
    isSecret: v.boolean(),
    name: v.string(),
    placeholder: v.optional(v.string()),
    value: v.optional(v.string()),
});

const vRecommendedMcpServer = v.object({
    reason: v.string(),
    server: v.object({
        description: v.string(),
        icon: v.optional(v.string()),
        id: v.string(),
        remotes: v.array(
            v.object({
                headers: v.array(vRegistryInput),
                protocol: v.union(v.literal("http"), v.literal("sse")),
                url: v.string(),
                variables: v.array(vRegistryInput),
            }),
        ),
        repositoryUrl: v.optional(v.string()),
        title: v.string(),
        websiteUrl: v.optional(v.string()),
    }),
});

const vMarketplaceMatch = v.object({
    _id: v.id("skills"),
    description: v.string(),
    name: v.string(),
    rating: v.number(),
    ratingCount: v.number(),
    slug: v.string(),
    usageCount: v.number(),
});

const vRecommendedSkill = v.object({
    reason: v.string(),
    skill: vMarketplaceMatch,
});

const vBuilderRecommendations = v.object({
    connectors: v.array(v.object({ id: v.string(), reason: v.string() })),
    marketplaceSkills: v.array(vRecommendedSkill),
    /** False when the MCP registry could not be reached — the UI says so rather than implying "none fit". */
    mcpRegistryAvailable: v.boolean(),
    mcpServers: v.array(vRecommendedMcpServer),
});

// ============================================================================
// Structured output schemas (what the model is asked to return)
// ============================================================================

const rawReasonItem = { reason: z.string().optional() };

const rawDraftSchema = z.object({
    category: z.string().optional(),
    description: z.string(),
    disableTools: z.array(z.object({ name: z.string(), ...rawReasonItem })).optional(),
    enableTools: z.array(z.object({ name: z.string(), ...rawReasonItem })).optional(),
    instructions: z.string(),
    name: z.string(),
    preferredModel: z.string().nullish(),
    preferredModelReason: z.string().optional(),
    reasoningEffort: z.number().nullish(),
    reasoningEffortReason: z.string().optional(),
    searchMode: z.string().nullish(),
    searchModeReason: z.string().optional(),
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

const rawTurnSchema = z.object({
    connectors: z.array(z.object({ id: z.string(), ...rawReasonItem })).optional(),
    draft: rawDraftSchema.optional(),
    marketplaceQueries: z.array(z.string()).optional(),
    mcpSearches: z.array(z.object({ query: z.string(), ...rawReasonItem })).optional(),
    questions: z.array(z.object({ options: z.array(z.string()).optional(), question: z.string(), why: z.string().optional() })).optional(),
    status: z.enum(["needs_clarification", "ready"]),
});

const rawPatchSchema = rawDraftSchema.partial();

// ============================================================================
// Helpers
// ============================================================================

const requireText = (value: string, label: string, min: number, max: number): string => {
    const trimmed = value.trim();

    if (trimmed.length < min) {
        throw new LunoraError("BAD_REQUEST", `${label} is too short`);
    }

    if (trimmed.length > max) {
        throw new LunoraError("BAD_REQUEST", `${label} must be under ${max} characters`);
    }

    return trimmed;
};

const callModel = async <SCHEMA extends z.ZodType>(
    gateway: ServiceFetch,
    userId: string,
    schema: SCHEMA,
    prompt: { prompt: string; system: string },
): Promise<z.infer<SCHEMA>> => {
    // Through the LLM gateway, so the call is metered and attributed like every other.
    const model = await getUtilityModel(gateway, { userId }, DEFAULT_PROMPT_IMPROVEMENT_MODEL);

    const result = await generateText({
        maxOutputTokens: 6000,
        model,
        output: Output.object({ schema }),
        prompt: prompt.prompt,
        system: prompt.system,
        temperature: 0.4,
    });

    return result.output as z.infer<SCHEMA>;
};

const toBadRequest = (error: unknown): never => {
    if (error instanceof BuilderOutputError) {
        throw new LunoraError("BAD_REQUEST", error.message);
    }

    throw error;
};

/** Public marketplace matches, the same filter `searchSkills` applies. */
export const searchMarketplaceForBuilder = internalQuery
    .input({ queries: v.array(v.string()) })
    .output(v.array(v.object({ query: v.string(), skills: v.array(vMarketplaceMatch) })))
    .query(async ({ args: { queries }, ctx }) =>
        Promise.all(
            queries.map(async (query) => {
                const skills = await searchMarketplaceSkills(ctx, query, MARKETPLACE_SKILLS_PER_QUERY);

                return {
                    query,
                    skills: skills.map((skill) => {
                        return {
                            _id: skill._id,
                            description: skill.description,
                            name: skill.name,
                            rating: skill.rating,
                            ratingCount: skill.ratingCount,
                            slug: skill.slug,
                            usageCount: skill.usageCount,
                        };
                    }),
                };
            }),
        ),
    );

// ============================================================================
// Procedures
// ============================================================================

/**
 * One builder turn: clarifying questions, or a draft with recommendations.
 * Questions are only asked while `answers` is empty and `skipQuestions` unset,
 * so the conversation takes at most one clarifying round.
 */
export const runBuilderTurn = authAction
    .use(rateLimit("skills/builder"))
    .input({
        answers: v.optional(v.array(v.object({ answer: v.string().max(MAX_LENGTH.text), question: v.string().max(MAX_LENGTH.text) }))),
        goal: v.string().max(MAX_LENGTH.text),
        skipQuestions: v.optional(v.boolean()),
    })
    .output(
        v.union(
            v.object({
                kind: v.literal("questions"),
                questions: v.array(v.object({ options: v.array(v.string()), question: v.string(), why: v.optional(v.string()) })),
            }),
            v.object({ draft: vBuilderDraft, kind: v.literal("draft"), recommendations: vBuilderRecommendations }),
        ),
    )
    .action(async ({ args, ctx }) => {
        const goal = requireText(args.goal, "The goal", 10, MAX_GOAL_LENGTH);
        const answers = (args.answers ?? []).slice(0, MAX_CLARIFYING_QUESTIONS).map((item) => {
            return { answer: item.answer.trim().slice(0, MAX_ANSWER_LENGTH), question: item.question.trim().slice(0, MAX_ANSWER_LENGTH) };
        });
        const allowQuestions = answers.length === 0 && args.skipQuestions !== true;
        const whitelist = getWhitelist();

        const raw = await callModel(
            gatewayFetch(ctx),
            ctx.user.userId,
            rawTurnSchema,
            buildBuilderTurnPrompt({ answers, goal }, whitelist, { allowQuestions }),
        );
        const turn = (() => {
            try {
                return parseBuilderResponse(raw as RawBuilderResponse, whitelist, { allowQuestions });
            } catch (error) {
                return toBadRequest(error);
            }
        })();

        if (turn.kind === "questions") {
            ctx.log.event("skills.builder_turn", { answerCount: answers.length, kind: "questions" });

            return turn;
        }

        const { suggestions } = turn;

        // Registry search and marketplace search run in parallel; the registry
        // degrades to "unavailable" rather than failing the whole turn.
        let mcpRegistryAvailable = true;

        const [mcpResults, marketplaceResults] = await Promise.all([
            Promise.all(
                suggestions.mcpSearches.map(async (search) => {
                    try {
                        const page = await fetchCachedRegistryPage(ctx, search.query);

                        return page.servers.slice(0, MCP_SERVERS_PER_SEARCH).map(({ version: _version, ...server }) => {
                            return { reason: search.reason, server };
                        });
                    } catch (error) {
                        mcpRegistryAvailable = false;
                        logger.warn("Agent builder: MCP registry unavailable", error);

                        return [];
                    }
                }),
            ),
            suggestions.marketplaceQueries.length > 0
                ? ctx.runQuery(internal.skills.builder.searchMarketplaceForBuilder, { queries: suggestions.marketplaceQueries })
                : Promise.resolve([]),
        ]);

        const seenServers = new Set<string>();
        const mcpServers = mcpResults.flat().filter((item) => !seenServers.has(item.server.id) && seenServers.add(item.server.id));

        const seenSkills = new Set<string>();
        const marketplaceSkills = marketplaceResults
            .flatMap(({ query, skills }) =>
                skills.map((skill) => {
                    return { reason: `Public skill matching "${query}"`, skill };
                }),
            )
            .filter((item) => !seenSkills.has(item.skill._id) && seenSkills.add(item.skill._id))
            .slice(0, MAX_MARKETPLACE_RECOMMENDATIONS);

        ctx.log.event("skills.builder_turn", {
            kind: "draft",
            marketplaceSkillCount: marketplaceSkills.length,
            mcpRegistryAvailable,
            mcpServerCount: mcpServers.length,
        });

        return {
            draft: turn.draft,
            kind: "draft" as const,
            recommendations: { connectors: suggestions.connectors, marketplaceSkills, mcpRegistryAvailable, mcpServers },
        };
    });

/**
 * Regenerate only the fields a follow-up instruction affects. Returns the new
 * draft and which fields changed; the client renders the diff.
 */
export const refineBuilderDraft = authAction
    .use(rateLimit("skills/builder"))
    .input({
        draft: vBuilderDraft,
        instruction: v.string().max(MAX_LENGTH.text),
    })
    .output(v.object({ changedFields: v.array(v.string()), draft: vBuilderDraft }))
    .action(async ({ args, ctx }) => {
        const instruction = requireText(args.instruction, "The change", 3, MAX_REFINE_INSTRUCTION_LENGTH);
        const whitelist = getWhitelist();
        // The incoming draft came from the client: normalise it through the same
        // whitelist before it is used as the baseline.
        const { draft: current } = applyRefinement(args.draft as BuilderDraft, {}, whitelist);

        const patch = await callModel(gatewayFetch(ctx), ctx.user.userId, rawPatchSchema, buildRefinePrompt({ draft: current, instruction }, whitelist));

        ctx.log.event("skills.refine_builder_draft", { instructionLength: instruction.length });

        return applyRefinement(current, patch as RawBuilderDraft, whitelist);
    });

/**
 * Attach an unsaved draft to one of the caller's temporary threads, so every
 * message there runs as that draft (see `resolveSkillsForRun`). The draft is
 * stored on the `temporaryThreads` row and deleted with it. The thread is
 * created by the ordinary `chat_functions.createThread({ temporary: true })`.
 */
export const attachSkillTestDrive = authMutation
    .use(rateLimit("skills/builder"))
    .input({
        config: v.optional(vSkillConfig),
        instructions: v.string().max(MAX_LENGTH.document),
        name: v.string().max(MAX_LENGTH.short),
        threadId: v.id("threads"),
        variables: v.optional(v.array(v.object({ defaultValue: v.optional(v.string().max(MAX_LENGTH.document)), name: v.string().max(MAX_LENGTH.short) }))),
        variableValues: v.optional(v.record(v.string().max(MAX_LENGTH.document), v.string().max(MAX_LENGTH.document))),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const thread = await ctx.db.get(args.threadId as Id<"threads">);

        // NOT_FOUND for someone else's thread too, so a probe learns nothing.
        if (!thread || thread.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Thread not found");
        }

        const row = await ctx.db
            .query("temporaryThreads")
            .withIndex("by_thread", (query) => query.eq("threadId", args.threadId))
            .first();

        // Only a temporary thread: the draft must disappear with it.
        if (!row) {
            throw new LunoraError("BAD_REQUEST", "A test drive needs a temporary chat");
        }

        const instructions = requireText(
            resolveDraftInstructions(args.instructions, args.variables ?? [], args.variableValues ?? {}),
            "Instructions",
            1,
            MAX_INSTRUCTIONS_LENGTH,
        );

        await patchTemporaryThread(ctx.db, row._id, {
            skillDraft: {
                config: sanitizeRunConfig(args.config, getWhitelist()),
                instructions,
                name: args.name.trim().slice(0, 100) || "Draft",
            },
        });

        ctx.log.event("skills.attach_test_drive", { threadId: args.threadId });

        return null;
    });
