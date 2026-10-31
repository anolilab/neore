/**
 * The quick check for ONE interactive run: the classifier call behind
 * `createLowRiskApprover` (`low-risk-approval.ts`) over the utility model, the
 * per-user budget, and the approvals it leaves on the run for `finishRun` to
 * stamp onto the saved tool calls.
 */
import { DEFAULT_MEMORY_EXTRACTION_MODEL } from "@neore/ai/constants";
import { generateText, Output } from "ai";
import z from "zod/v4";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import { gatewayFetch } from "../../lib/services";
import { getUtilityModel } from "../../lib/utility-model";
import type { AutoApprovals, LowRiskCheck } from "./low-risk-approval";
import { createLowRiskApprover, LOW_RISK_DEADLINE_MS, LOW_RISK_SYSTEM_PROMPT } from "./low-risk-approval";

const LOW_RISK_MODEL = DEFAULT_MEMORY_EXTRACTION_MODEL;

/** The shape the model is asked for; `parseLowRiskVerdict` then judges what came back. */
const verdictSchema = z.object({ lowRisk: z.boolean(), reason: z.string() }).strict();

export const createRunLowRiskCheck = (
    ctx: ActionCtx,
    args: {
        threadId: string;
        /** Resolves once the run's prompt is known: whether it carries knowledge, memory or project context (`injectsUntrustedContext`). */
        untrustedContext: Promise<boolean>;
        userId: string;
    },
): { approvals: AutoApprovals; check: LowRiskCheck } => {
    const { threadId, untrustedContext, userId } = args;
    const approvals: AutoApprovals = {};

    const classify = async (prompt: string): Promise<unknown> => {
        const model = await getUtilityModel(gatewayFetch(ctx), { threadId, userId }, LOW_RISK_MODEL);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error("The quick check ran out of time"));
            }, LOW_RISK_DEADLINE_MS);
        });
        const run = generateText({
            abortSignal: controller.signal,
            maxRetries: 0,
            model,
            output: Output.object({ schema: verdictSchema }),
            prompt,
            system: LOW_RISK_SYSTEM_PROMPT,
        });

        // Aborted after the deadline won the race, it rejects with nobody listening.
        run.catch(() => {});

        try {
            const result = await Promise.race([run, deadline]);

            return result.output;
        } finally {
            clearTimeout(timer);
        }
    };

    const check = createLowRiskApprover({
        classify,
        // Re-reads the setting and the thread's sharing, so switching the setting off or sharing the thread mid-run holds from the next call.
        consumeBudget: async () => await ctx.runMutation(internal.chat.tool_permissions.consumeLowRiskCheck, { threadId: threadId as Id<"threads">, userId }),
        model: LOW_RISK_MODEL,
        now: () => Date.now(),
        // An approval is also stamped on the saved call at `finishRun`; this is the trace a run that never gets there leaves.
        onOutcome: (outcome, call) =>
            ctx.log.event("chat.low_risk_check", {
                outcome,
                threadId,
                ...(outcome === "approved" && { permissionKey: call.key, toolCallId: call.toolCallId }),
            }),
        record: (toolCallId, record) => {
            approvals[toolCallId] = record;
        },
        stillAllowed: async (call) =>
            await ctx.runQuery(internal.chat.tool_permissions.getLowRiskApprovalContext, {
                permissionKey: call.key,
                threadId: threadId as Id<"threads">,
                userId,
            }),
        untrustedContext: () => untrustedContext,
    });

    return { approvals, check };
};
