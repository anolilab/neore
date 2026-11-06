"use client";

/**
 * "Copy prompt link" for a user message: a link that opens a new chat with that message as its draft, on the model the
 * composer uses now. The link never sends.
 */

import { useLingui } from "@lingui/react/macro";
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { LinkIcon } from "lucide-react";
import type { FC } from "react";

import { useModelStore } from "@/features/chat/core/stores/model-store";
import { buildPromptLink, isPromptLinkTooLong } from "@/features/chat/core/utils/prompt-link";
import type { UIMessage } from "@/lib/agent";
import { showError, showSuccess, showWarning } from "@/lib/toast";

const CopyPromptLinkAction: FC<{ message: UIMessage }> = ({ message }) => {
    const { t } = useLingui();

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

        const link = buildPromptLink(globalThis.location.origin, { model: useModelStore.getState().selectedModel, prompt });

        // A browser without the Clipboard API throws here, synchronously, as a refused write rejects: both are one failure.
        try {
            await navigator.clipboard.writeText(link);
            showSuccess(t`Prompt link copied`);
        } catch {
            showError(t`Could not copy the link`);
        }
    };

    return (
        <MessageAction label={t`Copy prompt link`} onClick={copy} tooltip={t`Copy prompt link`}>
            <LinkIcon aria-hidden="true" className="size-4" />
        </MessageAction>
    );
};

export default CopyPromptLinkAction;
