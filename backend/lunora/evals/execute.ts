/**
 * One eval case: generate an answer against the run's target, then score it.
 *
 * - `skill` / `model` targets run through `runHeadlessAgent` exactly as a task
 *   round does — a fresh thread, the interactive tool set built `headless` so a
 *   tool the user set to `ask` is simply absent — but with personalization and
 *   memory off, so a case scores the same for whoever runs it, and with an
 *   interactive turn's step budget rather than Deep Work's.
 * - `knowledge` targets retrieve with `knowledge_retrieve.search` (the same
 *   hybrid search the chat tool uses), score retrieval against the case's
 *   expected sources, then answer from what was retrieved with no tools.
 *
 * Each case's thread is marked temporary (kept {@link THREAD_RETENTION_HOURS}),
 * so a 200-case run does not fill the sidebar and cleans up after itself; the
 * answer itself stays on the result row.
 *
 * State lives in `evals/internal.ts`: this action claims its case first and
 * reports once at the end, so everything between is safe to lose.
 */
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { MODEL_LOOKUP } from "@neore/ai/models";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";
import z from "zod/v4";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { gatewayFetch, type ServiceFetch } from "../lib/services";
import { sumMessageCosts } from "../agent/message-cost";
import { getMaxSteps } from "../chat/lib/auto-continue";
import { runHeadlessAgent } from "../chat/lib/headless-run";
import { resolveTaskModel } from "../tasks/logic";
import type { vCaseOutcome } from "./internal";
import type { JudgeVerdict } from "./judge";
import {
    buildCorrectnessPrompt,
    buildFaithfulnessPrompt,
    buildGroundedAnswerSystem,
    CORRECTNESS_JUDGE_SYSTEM_PROMPT,
    FAITHFULNESS_JUDGE_SYSTEM_PROMPT,
    parseJudgeOutput,
} from "./judge";
import type { CheckKind, RetrievalMetrics } from "./metrics";
import { ANSWER_MAX, computeRetrievalMetrics, runCheck, scoreCase, unpricedCaseTokens } from "./metrics";
import type { ReplySkill } from "../usage/activity-logic";

const JUDGE_TIMEOUT_MS = 60_000;

const THREAD_RETENTION_HOURS = 24 * 7;

type CaseOutcome = Infer<typeof vCaseOutcome>;

interface Claim {
    checks: { kind: CheckKind; value: string }[];
    datasetKind: "agent" | "rag";
    expectedAnswer?: string;
    expectedSources: string[];
    input: string;
    judgeEnabled: boolean;
    organizationId?: string;
    resultId: Id<"evalResults">;
    rubric?: string;
    target:
        | { fileIds: Id<"knowledgeFiles">[]; kind: "knowledge"; model?: string }
        | { kind: "model"; model: string; systemPrompt?: string }
        | { kind: "skill"; model?: string; skillId: Id<"skills"> };
    userId: string;
}

/** A failure the user should read as-is, rather than a stack trace. */
class EvalCaseError extends Error {}

const judgeSchema = z.object({
    reasons: z.array(z.string()).meta({ description: "Brief reasons for the score" }),
    score: z.number().meta({ description: "Score from 0 to 1" }),
});

/** One structured judge call on the utility model. Unreadable output scores 0 (see `parseJudgeOutput`); an unreachable model throws. */
const judge = async (input: {
    /** The calling action's gateway binding. */
    gateway: ServiceFetch;
    prompt: string;
    system: string;
    threadId?: string;
    userId: string;
}): Promise<{ costMicrodollars?: number; tokens?: number; verdict: JudgeVerdict }> => {
    const { getUtilityModel } = await import("../lib/utility-model");
    const model = await getUtilityModel(input.gateway, { threadId: input.threadId, userId: input.userId });

    try {
        const result = await generateText({
            abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
            model,
            output: Output.object({ schema: judgeSchema }),
            prompt: input.prompt,
            system: input.system,
            temperature: 0,
        });

        return {
            costMicrodollars: sumMessageCosts(result.steps.map((step) => step.providerMetadata))?.microdollars,
            tokens: result.totalUsage.totalTokens,
            verdict: parseJudgeOutput(result.output),
        };
    } catch (error) {
        // The model answered, but not in the schema: read what it said.
        if (NoObjectGeneratedError.isInstance(error)) {
            return { verdict: parseJudgeOutput(error.text ?? "") };
        }

        throw error;
    }
};

const addCost = (total: number | undefined, cost: number | undefined): number | undefined => (cost === undefined ? total : (total ?? 0) + cost);

/**
 * A case's spend across its calls (the agent, then up to two judge calls). The
 * judge may be priced by the gateway while the agent ran on the user's own key
 * with no pricing, so unpriced tokens are counted PER CALL — summing cost first
 * would let a priced judge hide an unpriced agent from the token budget.
 */
const createCaseSpend = () => {
    let costMicrodollars: number | undefined;
    let tokens: number | undefined;
    let unpricedTokens = 0;

    return {
        add(call: { costMicrodollars?: number; tokens?: number }, text: string): void {
            costMicrodollars = addCost(costMicrodollars, call.costMicrodollars);
            tokens = call.tokens === undefined ? tokens : (tokens ?? 0) + call.tokens;
            unpricedTokens += unpricedCaseTokens(call.costMicrodollars, call.tokens, text);
        },
        get costMicrodollars(): number | undefined {
            return costMicrodollars;
        },
        get fields(): { costMicrodollars?: number; tokens?: number; unpricedTokens: number } {
            return {
                ...(costMicrodollars !== undefined && { costMicrodollars }),
                ...(tokens !== undefined && { tokens }),
                unpricedTokens,
            };
        },
    };
};

const resolveModel = async (
    ctx: ActionCtx,
    claim: Claim,
): Promise<{ model: string; skill?: { config?: Record<string, unknown>; instructions: string }; usageSkill?: ReplySkill }> => {
    const { target } = claim;
    const lookup = (id: string) => MODEL_LOOKUP.get(id);

    if (target.kind === "skill") {
        const skill = await ctx.runQuery(internal.tasks.internal.resolveTaskSkill, {
            organizationId: claim.organizationId,
            skillId: target.skillId,
            userId: claim.userId,
        });

        if ("error" in skill) {
            throw new EvalCaseError(skill.error);
        }

        const model = resolveTaskModel({ defaultModel: DEFAULT_CHAT_MODEL, lookup, preferredModel: skill.config?.preferredModel, taskModel: target.model });

        if (!model) {
            throw new EvalCaseError("The run's model is no longer available.");
        }

        return {
            model,
            skill: skill as { config?: Record<string, unknown>; instructions: string },
            usageSkill: { id: target.skillId, name: `/${skill.slug}` },
        };
    }

    const model = resolveTaskModel({ defaultModel: DEFAULT_CHAT_MODEL, lookup, taskModel: target.model });

    if (!model) {
        throw new EvalCaseError("The run's model is no longer available.");
    }

    return { model };
};

/** Marks a case's thread temporary so it leaves the sidebar and is cleaned up. Best-effort. */
const retireThread = async (ctx: ActionCtx, threadId: string): Promise<void> => {
    try {
        await ctx.runMutation(internal.agent.threads.createTemporaryThread, {
            expiresAt: Date.now() + THREAD_RETENTION_HOURS * 3_600_000,
            retentionHours: THREAD_RETENTION_HOURS,
            threadId: threadId as Id<"threads">,
        });
    } catch (error) {
        console.warn(`[Evals] Could not mark thread ${threadId} temporary:`, error);
    }
};

interface Retrieved {
    chunks: { content: string; fileId?: string; fileName: string; score: number }[];
    latencyMs: number;
    metrics?: RetrievalMetrics;
}

const retrieve = async (ctx: ActionCtx, claim: Claim, fileIds: string[]): Promise<Retrieved> => {
    const started = Date.now();
    const hits = (await ctx.runAction(internal.knowledge.retrieve.search, {
        fileIds: fileIds.length > 0 ? fileIds : undefined,
        query: claim.input,
        userId: claim.userId,
    })) as { content: string; fileId?: string; fileName: string; score: number }[];
    const latencyMs = Date.now() - started;
    const metrics =
        claim.expectedSources.length > 0
            ? computeRetrievalMetrics(
                  hits.map((hit) => {
                      return { fileId: hit.fileId, fileName: hit.fileName };
                  }),
                  claim.expectedSources,
              )
            : undefined;

    return { chunks: hits, latencyMs, metrics };
};

const evaluateCase = async (ctx: ActionCtx, claim: Claim, onThread: (threadId: string) => void): Promise<CaseOutcome> => {
    const { model, skill, usageSkill } = await resolveModel(ctx, claim);
    const { target, userId } = claim;
    let retrieved: Retrieved | undefined;
    let system: string | undefined;

    if (target.kind === "knowledge") {
        retrieved = await retrieve(ctx, claim, target.fileIds as string[]);
        system = buildGroundedAnswerSystem(retrieved.chunks);
    } else if (target.kind === "model") {
        system = target.systemPrompt;
    }

    const started = Date.now();
    const run = await runHeadlessAgent(ctx, {
        beforeThread: async () => {
            if (!(await ctx.runQuery(internal.evals.internal.canRunForUser, { userId }))) {
                throw new EvalCaseError("This account is being deleted.");
            }
        },
        maxSteps: getMaxSteps(false),
        memory: false,
        model,
        onThread,
        personalization: "none",
        prompt: claim.input,
        skill: skill as Parameters<typeof runHeadlessAgent>[1]["skill"],
        system,
        thread: { tags: ["eval"], title: `Eval: ${claim.input}`.slice(0, 120) },
        tools: target.kind === "knowledge" ? "none" : "headless",
        ...(usageSkill && { usageSkill }),
        userId,
    });
    const latencyMs = Date.now() - started;
    const answer = run.text.trim().slice(0, ANSWER_MAX);
    const spend = createCaseSpend();

    spend.add({ costMicrodollars: run.costMicrodollars, tokens: run.totalTokens }, `${system ?? ""}${claim.input}${answer}`);

    if (answer.length === 0) {
        return { ...spend.fields, error: "The agent finished without producing an answer.", kind: "error", latencyMs, threadId: run.threadId };
    }

    let correctness: JudgeVerdict | undefined;
    let faithfulness: JudgeVerdict | undefined;

    try {
        const wantsCorrectness = claim.judgeEnabled && (claim.datasetKind === "agent" || claim.expectedAnswer !== undefined || claim.rubric !== undefined);

        if (wantsCorrectness) {
            const prompt = buildCorrectnessPrompt({ answer, expectedAnswer: claim.expectedAnswer, input: claim.input, rubric: claim.rubric });
            const verdict = await judge({ gateway: gatewayFetch(ctx), prompt, system: CORRECTNESS_JUDGE_SYSTEM_PROMPT, threadId: run.threadId, userId });

            correctness = verdict.verdict;
            spend.add(verdict, prompt);
        }

        if (claim.judgeEnabled && retrieved && retrieved.chunks.length > 0) {
            const prompt = buildFaithfulnessPrompt({ answer, contexts: retrieved.chunks, question: claim.input });
            const verdict = await judge({ gateway: gatewayFetch(ctx), prompt, system: FAITHFULNESS_JUDGE_SYSTEM_PROMPT, threadId: run.threadId, userId });

            faithfulness = verdict.verdict;
            spend.add(verdict, prompt);
        }
    } catch (error) {
        console.warn("[Evals] Judge failed:", error);

        // The answer exists; only its grade is missing. Inventing a score would
        // make the run look worse (or better) than it is.
        return {
            answer,
            ...spend.fields,
            error: "The judge model could not be reached, so this case was not scored.",
            kind: "error",
            latencyMs,
            threadId: run.threadId,
        };
    }

    const { costMicrodollars } = spend;
    const checks = claim.checks.map((check) => runCheck(check, { answer, costMicrodollars, latencyMs }));
    const retrieval = retrieved?.metrics
        ? {
              contextPrecision: retrieved.metrics.contextPrecision,
              contextRecall: retrieved.metrics.contextRecall,
              hitAtK: retrieved.metrics.hitAtK,
              k: retrieved.metrics.k,
              latencyMs: retrieved.latencyMs,
              mrr: retrieved.metrics.mrr,
              retrieved: retrieved.chunks.map((chunk, index) => {
                  return {
                      ...(chunk.fileId !== undefined && { fileId: chunk.fileId }),
                      fileName: chunk.fileName,
                      relevant: retrieved.metrics!.relevant[index] ?? false,
                      score: chunk.score,
                  };
              }),
          }
        : undefined;
    const { passed, score } = scoreCase({ checks, faithfulness, judge: correctness, retrieval });

    return {
        answer,
        checks,
        ...spend.fields,
        faithfulness,
        judge: correctness,
        kind: "scored",
        latencyMs,
        passed,
        retrieval,
        score,
        threadId: run.threadId,
    };
};

export const runEvalCase = internalAction
    .input({ index: v.number(), runId: v.id("evalRuns") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const claim = await ctx.runMutation(internal.evals.internal.claimCase, args);

        if (!claim) {
            return null;
        }

        let threadId: string | undefined;
        let outcome: CaseOutcome;

        try {
            outcome = await evaluateCase(ctx, claim as Claim, (id) => {
                threadId = id;
            });
        } catch (error) {
            console.error(`[Evals] Case ${String(args.index)} of run ${args.runId} failed:`, error);

            const detail = error instanceof Error ? error.message : String(error);

            outcome = {
                error: error instanceof EvalCaseError ? error.message : `The case failed: ${detail}`.slice(0, 2000),
                kind: "error",
                ...(threadId !== undefined && { threadId }),
            };
        }

        if (threadId) {
            await retireThread(ctx, threadId);
        }

        await ctx.runMutation(internal.evals.internal.completeCase, { outcome, resultId: claim.resultId });

        return null;
    });
