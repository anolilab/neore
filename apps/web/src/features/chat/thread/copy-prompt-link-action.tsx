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
import { buildPromptLink, carriableLinkModel, isPromptLinkTooLong } from "@/features/chat/core/utils/prompt-link";
import type { UIMessage } from "@/lib/agent";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError, showSuccess, showWarning } from "@/lib/toast";

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
        // A browser without the Clipboard API throws here, as a refused write rejects: both are one failure.
        try {
            await writeLink(link);
            showSuccess(t`Prompt link copied`);
        } catch {
            showError(t`Could not copy the link`);
        }
    };

    const copy = async () => {
        const prompt = getVisibleUserText({ parts: [...message.parts], text: message.text });

        if (!prompt.trim()) {
            showWarning(t`This message has no text to copy as a prompt link.`);

            return;
        }

        // A link carries at most PROMPT_LINK_MAX_CHARS; copying a longer message would give the reader part of it.
        if (isPromptLinkTooLong(prompt)) {
            showWarning(t`This message is too long to copy as a prompt link.`);

            return;
        }

        // A link can only name a model the composer takes for text. A custom endpoint's model is not one, so the link is refused
        // rather than opening on another model. A chat that is not a bot chat knows its model now, so that refusal is decided
        // before anything reaches the clipboard and its notice is exact.
        if (!isBotChat) {
            const linkModel = shownModel(undefined);

            if (!carriableLinkModel(linkModel)) {
                showWarning(t`A prompt link cannot name this chat's model, so no link was copied.`);

                return;
            }

            await copyLink(() => Promise.resolve(buildPromptLink(globalThis.location.origin, { model: linkModel, prompt })));

            return;
        }

        await copyLink(async () => {
            const linkModel = shownModel(await freshBotModel());

            if (!carriableLinkModel(linkModel)) {
                throw new Error("A prompt link cannot name this bot's model.");
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
