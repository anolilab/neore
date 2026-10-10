"use client";

import { useLingui } from "@lingui/react/macro";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { LanguagesIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";

import { defaultTranslationLanguage, useTranslationStore } from "./translation-store";

/**
 * Action-bar button that shows or hides a message's translation (rendered by
 * `MessageTranslation`). Not offered to guests: the server refuses them
 * (translating spends the daily text quota of an account).
 */
const TranslateAction: FC<{ messageId: string }> = ({ messageId }) => {
    const { i18n, t } = useLingui();
    const { isAnonymous } = useIsAnonymous();
    const isOpen = useTranslationStore((state) => Object.hasOwn(state.entries, messageId));
    const open = useTranslationStore((state) => state.open);
    const close = useTranslationStore((state) => state.close);

    const handleClick = useCallback(() => {
        if (isOpen) {
            close(messageId);
        } else {
            open(messageId, defaultTranslationLanguage(i18n.locale));
        }
    }, [close, i18n.locale, isOpen, messageId, open]);

    if (isAnonymous) {
        return null;
    }

    return (
        <MessageAction aria-pressed={isOpen} onClick={handleClick} tooltip={isOpen ? t`Hide translation` : t`Translate`}>
            <LanguagesIcon aria-hidden="true" className="size-4" />
        </MessageAction>
    );
};

export default TranslateAction;
