"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { Button } from "@neore/ui/components/button";
import useStreamdownPlugins from "@neore/ui/hooks/use-streamdown-plugins";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, LanguagesIcon, Loader2Icon, RotateCcwIcon, XIcon } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useId, useMemo } from "react";
import { Streamdown } from "streamdown";

import type { UIMessage } from "@/lib/agent";
import { createLunoraActionQueryOptions, useLunora } from "@/lib/lunora/crpc";

import type { TranslationEntry } from "./translation-store";
import { displayLanguageName, translationLanguageOptions, useTranslationStore } from "./translation-store";

/** The server's reason, when it is one the user can act on (`chat_translate.translateMessage`). */
const translationErrorKind = (error: unknown): "forbidden" | "other" | "quota" => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };
    const codes = new Set([code, data?.code]);

    if (codes.has("TOO_MANY_REQUESTS")) {
        return "quota";
    }

    return codes.has("FORBIDDEN") ? "forbidden" : "other";
};

/** A fetched translation does not go stale; only a different text or language is a new request. */
const TRANSLATION_STALE_TIME = Infinity;
const TRANSLATION_GC_TIME = 30 * 60 * 1000;

const TranslatedText: FC<{ language: string; text: string }> = ({ language, text }) => {
    const plugins = useStreamdownPlugins(text);

    return (
        <div lang={language}>
            <Streamdown plugins={plugins}>{text}</Streamdown>
        </div>
    );
};

const TranslationPanel: FC<{ entry: TranslationEntry; messageId: string; text: string }> = ({ entry, messageId, text }) => {
    const { i18n, t } = useLingui();
    const client = useLunora();
    const bodyId = useId();
    const selectId = useId();
    const close = useTranslationStore((state) => state.close);
    const setLanguage = useTranslationStore((state) => state.setLanguage);
    const toggleCollapsed = useTranslationStore((state) => state.toggleCollapsed);

    const options = useMemo(() => translationLanguageOptions(i18n.locale), [i18n.locale]);
    const { data, error, isFetching, refetch } = useQuery({
        ...createLunoraActionQueryOptions(client, api.chat.translate.translateMessage, { messageId, targetLanguage: entry.language, text }),
        enabled: text.trim().length > 0,
        gcTime: TRANSLATION_GC_TIME,
        retry: false,
        staleTime: TRANSLATION_STALE_TIME,
    });

    const languageName = displayLanguageName(entry.language, i18n.locale);
    const handleRetry = () => {
        refetch().catch(() => undefined);
    };

    let body: ReactNode;

    if (data) {
        body = <TranslatedText language={data.targetLanguage} text={data.translation} />;
    } else if (error) {
        const errorTexts = {
            forbidden: t`Create an account to translate messages.`,
            other: t`Translation failed.`,
            quota: t`You have used today's translations. Try again later.`,
        };

        body = (
            <div className="flex items-center gap-2" role="alert">
                <span className="text-destructive text-xs">{errorTexts[translationErrorKind(error)]}</span>
                <Button className="h-6 gap-1 px-2 text-xs" onClick={handleRetry} size="sm" type="button" variant="ghost">
                    <RotateCcwIcon aria-hidden="true" className="size-3" />
                    {t`Retry`}
                </Button>
            </div>
        );
    } else {
        body = (
            <span aria-live="polite" className="text-muted-foreground text-xs" role="status">
                {t`Translating…`}
            </span>
        );
    }

    return (
        <section aria-label={t`Translation to ${languageName}`} className="border-border bg-muted/40 mt-3 rounded-lg border text-sm">
            <div className="flex items-center gap-2 px-3 py-1.5">
                <button
                    aria-controls={bodyId}
                    aria-expanded={!entry.collapsed}
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs font-medium"
                    onClick={() => toggleCollapsed(messageId)}
                    type="button"
                >
                    {entry.collapsed ? (
                        <ChevronRightIcon aria-hidden="true" className="size-3.5" />
                    ) : (
                        <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                    )}
                    <LanguagesIcon aria-hidden="true" className="size-3.5" />
                    {t`Translation`}
                </button>
                <label className="sr-only" htmlFor={selectId}>{t`Target language`}</label>
                <select
                    className="border-border bg-background text-foreground rounded-md border px-1.5 py-0.5 text-xs"
                    id={selectId}
                    onChange={(event) => setLanguage(messageId, event.target.value)}
                    value={entry.language}
                >
                    {options.map((code) => (
                        <option key={code} value={code}>
                            {displayLanguageName(code, i18n.locale)}
                        </option>
                    ))}
                </select>
                {isFetching && <Loader2Icon aria-hidden="true" className="text-muted-foreground size-3.5 animate-spin" />}
                <div className="grow" />
                <Button aria-label={t`Close translation`} className="size-6" onClick={() => close(messageId)} size="icon-sm" type="button" variant="ghost">
                    <XIcon aria-hidden="true" className="size-3.5" />
                </Button>
            </div>
            <div className={entry.collapsed ? "hidden" : "border-border border-t px-3 py-2"} hidden={entry.collapsed} id={bodyId}>
                {body}
            </div>
        </section>
    );
};

/** The translation shown under a message once "Translate" was pressed. Renders nothing otherwise. */
const MessageTranslation: FC<{ message: UIMessage }> = ({ message }) => {
    const entry = useTranslationStore((state) => state.entries[message.id]);

    if (!entry) {
        return null;
    }

    return <TranslationPanel entry={entry} messageId={message.id} text={getVisibleUserText(message)} />;
};

export default MessageTranslation;
