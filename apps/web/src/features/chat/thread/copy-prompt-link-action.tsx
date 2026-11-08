"use client";

/**
 * "Copy prompt link" for a user message: a link that opens a new chat with that message as its draft, on the model the
 * composer uses now (`core/utils/prompt-link.ts`). The link never sends.
 */

import { useLingui } from "@lingui/react/macro";
import { enabledModelOf } from "@neore/ai/models";
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { LinkIcon } from "lucide-react";
import type { FC } from "react";

import { useChatThread } from "@/features/chat/core/context/chat-context";
import type { ChatThreadContextValue } from "@/features/chat/core/context/chat-context-types";
import { MIN_COMPARISON_MODELS, useModelStore } from "@/features/chat/core/stores/model-store";
import { buildPromptLink, isPromptLinkTooLong, promptFromLink } from "@/features/chat/core/utils/prompt-link";
import type { UIMessage } from "@/lib/agent";
import { showError, showSuccess, showWarning } from "@/lib/toast";

/**
 * The one text model the composer sends to now, read at the click. A comparison, a media mode, Auto and a bot (whose model the
 * row does not read) each send elsewhere, so the link then names no model and opens on the reader's own.
 */
const composerLinkModel = ({ model, thread, threadId }: ChatThreadContextValue): string | undefined => {
    const store = useModelStore.getState();
    const mode = threadId ? (store.threadModes.get(threadId) ?? "text") : store.newThreadMode;
    const auto = threadId ? thread?.autoModel === true && !thread.activeAgent : store.pendingSettings?.autoModel === true;
    const comparison = store.comparisonMode && store.selectedModelsForComparison.length >= MIN_COMPARISON_MODELS;

    if (comparison || auto || mode !== "text" || Boolean(thread?.botId) || enabledModelOf(model, { mode: "text" }) === undefined) {
        return undefined;
    }

    return model;
};

const CopyPromptLinkAction: FC<{ message: UIMessage }> = ({ message }) => {
    const { t } = useLingui();
    const chatThread = useChatThread();

    const copy = async (): Promise<void> => {
        const prompt = getVisibleUserText({ parts: [...message.parts], text: message.text });

        // The text the link carries has its hidden characters out, so a message of only those has nothing to copy.
        if (promptFromLink(prompt) === "") {
            showWarning(t`This message has no text to copy as a prompt link.`);

            return;
        }

        const model = composerLinkModel(chatThread);

        // A longer message would reach the reader cut, or as an address that does not open.
        if (isPromptLinkTooLong(prompt, model)) {
            showWarning(t`This message is too long to copy as a prompt link.`);

            return;
        }

        try {
            await navigator.clipboard.writeText(buildPromptLink(globalThis.location.origin, { model, prompt }));
        } catch {
            // A browser without the Clipboard API throws as a refused write rejects: both are one failure.
            showError(t`Could not copy the prompt link. Your browser did not allow access to the clipboard.`);

            return;
        }

        showSuccess(model === undefined ? t`Prompt link copied. It names no model, so it opens on the reader's model.` : t`Prompt link copied`);
    };

    return (
        <MessageAction label={t`Copy prompt link`} onClick={copy} tooltip={t`Copy prompt link`}>
            <LinkIcon aria-hidden="true" className="size-4" />
        </MessageAction>
    );
};

export default CopyPromptLinkAction;
