"use client";

/**
 * "Copy prompt link" for a user message: a link that opens a new chat with that message as its draft, on the model the
 * composer shows now. The link never sends.
 */

import { useLingui } from "@lingui/react/macro";
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { useQueryClient } from "@tanstack/react-query";
import { LinkIcon } from "lucide-react";
import type { FC } from "react";

import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { composerModelOf, composerModeOf } from "@/features/chat/core/utils/composer-model";
import { buildPromptLink, isPromptLinkTooLong } from "@/features/chat/core/utils/prompt-link";
import { carriableLinkModel } from "@/features/chat/core/utils/prompt-link-model";
import type { UIMessage } from "@/lib/agent";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError, showSuccess, showWarning } from "@/lib/toast";

/** A link that cannot be copied, with the sentence that tells the person why. */
class LinkRefusal extends Error {}

/**
 * Writes the link `link` produces. Where the browser has ClipboardItem the write starts at once and carries the pending
 * text: a browser that ties a clipboard write to the click (Safari) refuses one that waits on a network answer first. Where
 * it does not, the link is awaited and written as text.
 */
const writeLink = (link: () => Promise<string>): Promise<void> => {
    if (typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function") {
        const text = link().then((value) => new Blob([value], { type: "text/plain" }));

        return navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
    }

    return link().then((value) => navigator.clipboard.writeText(value));
};

const CopyPromptLinkAction: FC<{ message: UIMessage }> = ({ message }) => {
    const { t } = useLingui();
    // Read from the chat's thread context, not a hook of its own: a message row renders without the auth provider.
    const { isAnonymous, model, thread, threadId } = useChatThread();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const botId = thread?.botId ?? null;
    const isBotChat = typeof botId === "string" && botId.length > 0;

    // The same sentence is the warning when the chat's own model is known now, and the error when a bot's model is read on the click.
    const modelRefused = t`A prompt link cannot name this chat's model, so no link was copied.`;
    const tooLong = t`This message is too long to copy as a prompt link.`;

    // A bot chat runs on the bot's current model, which the composer shows; the thread may still store an older one. The bot
    // list is read on the click, not per message row, and is fetched again then: a cached list may predate a model change.
    // The list is owner-only, so a bot this person cannot see gives no model and the composer's own rule stands.
    const freshBotModel = async (): Promise<string | undefined> => {
        // The cached list is not reused: a one-shot read's cache never goes stale on its own, so a model changed elsewhere would show.
        const bots = await queryClient.fetchQuery({ ...crpc.bots.functions.listBots.queryOptions({}, { live: false }), staleTime: 0 });

        return bots.find((bot) => bot._id === botId)?.model;
    };

    /** The model the composer shows right now, read at the click: the same rule the composer's picker uses. */
    const shownModel = (botModel: string | undefined): string => {
        const store = useModelStore.getState();

        return composerModelOf({
            botModel,
            isAnonymous,
            mode: composerModeOf({
                newThreadMode: store.newThreadMode,
                threadId,
                threadMode: threadId ? store.threadModes.get(threadId) : undefined,
            }),
            threadModel: model,
        });
    };

    const copyLink = async (link: () => Promise<string>): Promise<void> => {
        // A refusal raised while the link was built is what the person is told. A clipboard write rejects with the build's
        // failure, so the refusal is kept on the side rather than read from the write's error.
        const refused: { message?: string } = {};
        const build = async (): Promise<string> => {
            try {
                return await link();
            } catch (error) {
                if (error instanceof LinkRefusal) {
                    refused.message = error.message;
                }

                throw error;
            }
        };

        // A browser without the Clipboard API throws here, as a refused write rejects: both are one failure.
        try {
            await writeLink(build);
            showSuccess(t`Prompt link copied`);
        } catch {
            showError(refused.message ?? t`Could not copy the link`);
        }
    };

    const copy = async () => {
        const prompt = getVisibleUserText({ parts: [...message.parts], text: message.text });

        if (!prompt.trim()) {
            showWarning(t`This message has no text to copy as a prompt link.`);

            return;
        }

        // A link can only name a model the composer takes for text. A custom endpoint's model is not one, so the link is refused
        // rather than opening on another model. A chat that is not a bot chat knows its model now, so its refusals are decided
        // before anything reaches the clipboard, and the warnings are exact.
        if (!isBotChat) {
            const linkModel = shownModel(undefined);

            if (!carriableLinkModel(linkModel)) {
                showWarning(modelRefused);

                return;
            }

            // A link carries at most PROMPT_LINK_MAX_CHARS, and an encoded query of a bounded length: copying a longer message would
            // give the reader part of it, or a link that does not open.
            if (isPromptLinkTooLong(prompt, linkModel)) {
                showWarning(tooLong);

                return;
            }

            await copyLink(() => Promise.resolve(buildPromptLink(globalThis.location.origin, { model: linkModel, prompt })));

            return;
        }

        await copyLink(async () => {
            const linkModel = shownModel(await freshBotModel());

            if (!carriableLinkModel(linkModel)) {
                throw new LinkRefusal(modelRefused);
            }

            if (isPromptLinkTooLong(prompt, linkModel)) {
                throw new LinkRefusal(tooLong);
            }

            return buildPromptLink(globalThis.location.origin, { model: linkModel, prompt });
        });
    };

    return (
        <MessageAction label={t`Copy prompt link`} onClick={copy} tooltip={t`Copy prompt link`}>
            <LinkIcon aria-hidden="true" className="size-4" />
        </MessageAction>
    );
};

export default CopyPromptLinkAction;
