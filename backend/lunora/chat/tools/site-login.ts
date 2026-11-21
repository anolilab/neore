/**
 * Signs the cloud browser in to a site with a login the person saved for it (`vault/site-logins.ts`). The model names the
 * sign-in page only. The server fills in the saved login itself, in `site-login-node.ts`: the model never sees it.
 *
 * The person approves every sign-in: `needsApproval` is hard-coded, and no override, time-boxed allow, thread mode or
 * headless run lifts it (`BUILTIN_TOOLS_NEEDING_A_PERSON`). Whether the turn may use a login at all is the verdict's
 * (`vault/site-login-turn.ts`), read from this call's tool context.
 */
import z from "zod/v4";

import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";
import { siteLoginTurnOf } from "../../vault/site-login-turn";
import { NO_USABLE_LOGIN, type SiteLoginFillResult } from "./site-login-node";
import toonEncodeOutput from "./toon-encode";

const signInWithSavedLoginTool = createTool<{ url: string }, SiteLoginFillResult, ToolContext>({
    description: `Sign in to a website in the cloud browser with the login the person saved for that site. Give the https:// address of the site's sign-in page: the server opens it and types the saved username and password itself, so you never see either, and the person approves every sign-in.
Use it only when the person asked you to sign in, or their task needs their own account on that site. It works only in the person's own chat, in a turn they typed, before any page was read in it.
After it, take a screenshot to see whether the sign-in worked. If there is no saved login for the site, ask the person to sign in themselves in the live view.`,
    execute: async (context, input, options) => {
        if (context.headless === true || !context.userId || !context.threadId) {
            return { error: NO_USABLE_LOGIN, success: false };
        }

        // An approved call runs with no messages (`agent/client/tool-approval.ts`): the verdict then reads its step from
        // the saved rows, and admits this call's own approval request only.
        const turn =
            context.runToolSources === undefined
                ? null
                : siteLoginTurnOf(context, { ownCallId: options.toolCallId, stepMessages: options.messages, toolSources: context.runToolSources });

        if (!turn) {
            return { error: NO_USABLE_LOGIN, success: false };
        }

        try {
            return await context.runAction(internal.chat.tools.site_login_node.fillSavedLogin, {
                threadId: context.threadId as Id<"threads">,
                // As the validator holds them: every message whole (a model message is its role, content and options).
                turn: {
                    ...turn,
                    stepMessages: options.messages.map((message) => {
                        return { content: message.content, providerOptions: message.providerOptions, role: message.role };
                    }),
                    systemContext: [...turn.systemContext],
                    toolSources: [...turn.toolSources],
                },
                url: input.url,
                userId: context.userId,
                userTier: context.userTier,
            });
        } catch (error) {
            // A failure before the renderer was called names nothing secret; the text is not the model's to see anyway.
            toolsLogger.error(`[SITE_LOGIN] Sign-in could not run: ${error instanceof Error ? error.name : "unknown"}`);

            return { error: "The sign-in could not run. Try it again.", success: false };
        }
    },
    inputSchema: z
        .object({
            url: z.string().max(2048).meta({ description: "The https:// address of the site's sign-in page" }),
        })
        .strict(),
    needsApproval: true,
    title: "Sign In With Saved Login",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default signInWithSavedLoginTool;
