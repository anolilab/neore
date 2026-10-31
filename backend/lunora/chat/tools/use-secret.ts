/**
 * The consumers of a requested secret (`request-secret.ts`): each takes the
 * reference `requestSecret` returned and sends the stored value where the user
 * approved it, server-side. The model never sees the value, only the outcome.
 *
 * The destination was fixed on the card, so these take no destination of their
 * own; the mutation behind them checks the reference belongs to this user and
 * this thread, has not expired or been used, was requested for this kind of
 * destination, and that the turn spending it was started by the owner (a
 * continuation runs as the owner whoever started the turn it resumes) — the
 * checks a manual save in Settings has by being the user's own session.
 */
import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { SECRET_REF_MAX } from "./request-secret-constants";

const inputSchema = z.object({ ref: z.string().min(1).max(SECRET_REF_MAX).meta({ description: "The reference requestSecret returned" }) }).strict();

export interface UseSecretInput {
    ref: string;
}

export type UseSecretOutput = { error: string; status: string } | { header: string; server: string; status: "saved" } | { provider: string; status: "saved" };

const refusal = (message: string): UseSecretOutput => {
    return { error: message, status: "failed" };
};

export const saveSecretAsProviderKeyTool = createTool<UseSecretInput, UseSecretOutput, ToolContext>({
    description: `Save a secret the user gave you with requestSecret (use.kind "provider_key") as their own API key for the provider they approved.
Takes the reference only; the value stays on the server. A reference works once, in the reply that received it.
The change applies from the user's next message: this reply keeps the key and the server connections it already has.`,
    execute: async (context, input) => {
        if (!context.userId || !context.threadId) {
            return refusal("Sign in to use a requested secret.");
        }

        const result = await context.runMutation(internal.chat.request_secret.consumeSecretAsProviderKey, {
            ref: input.ref,
            startedBy: context.startedBy ?? "",
            threadId: context.threadId,
            userId: context.userId,
        });

        return "message" in result ? { error: result.message, status: result.status } : result;
    },
    inputSchema,
    title: "Save Secret as Provider Key",
});

export const setMcpServerSecretTool = createTool<UseSecretInput, UseSecretOutput, ToolContext>({
    description: `Set a secret the user gave you with requestSecret (use.kind "mcp_header") as a header on the saved MCP server they approved.
Takes the reference only; the value stays on the server. A reference works once, in the reply that received it.
The change applies from the user's next message: this reply keeps the key and the server connections it already has.`,
    execute: async (context, input) => {
        if (!context.userId || !context.threadId) {
            return refusal("Sign in to use a requested secret.");
        }

        const result = await context.runMutation(internal.chat.request_secret.consumeSecretAsMcpHeader, {
            ref: input.ref,
            startedBy: context.startedBy ?? "",
            threadId: context.threadId,
            userId: context.userId,
        });

        return "message" in result ? { error: result.message, status: result.status } : result;
    },
    inputSchema,
    title: "Set MCP Server Secret",
});
