"use client";

import { useLingui } from "@lingui/react/macro";
import type { ReturnOf } from "@lunora/react";
import type { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import {
    Combobox,
    ComboboxEmpty,
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
    ComboboxPopup,
    ComboboxTrigger,
    ComboboxValue,
} from "@neore/ui/components/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDownIcon, Globe, SearchIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { DEFAULT_MESSAGE_OPTS } from "@/features/chat/core/constants/query-options";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { getValidThreadId } from "@/features/chat/core/hooks/use-validated-thread";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { createLanguageList, mapNavigatorLanguage } from "@/features/chat/core/utils/language-utilities";
import { useCRPC } from "@/lib/lunora/crpc";

/** The row shape `chat_functions.getThread` returns — used to type the optimistic cache writes. */
type ThreadRow = ReturnOf<typeof api.chat.functions.getThread>;

const ComposerLanguageSelector: FC = () => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const { threadId } = useChatThread();
    const validThreadId = getValidThreadId(threadId);
    const { data: threadData } = useQuery(crpc.chat.functions.getThread.queryOptions(validThreadId ? { threadId: validThreadId } : skipToken));
    // `mutate`, not `mutateAsync`: nothing awaits this call, and a discarded
    // rejected promise is an unhandled rejection. Failures roll back in `onError`.
    const { mutate: updateThreadLanguage } = useMutation({
        ...crpc.chat.functions.updateThreadLanguage.mutationOptions(),
        onMutate: async ({ language: newLanguage, threadId: mutationThreadId }) => {
            // Cancel outgoing refetches
            await queryClient.cancelQueries({
                queryKey: crpc.chat.functions.getThread.queryKey({ threadId: mutationThreadId }),
            });

            // Snapshot previous value
            const previousThread = queryClient.getQueryData<ThreadRow>(crpc.chat.functions.getThread.queryKey({ threadId: mutationThreadId }));

            // Optimistically update getThread cache
            queryClient.setQueryData(crpc.chat.functions.getThread.queryKey({ threadId: mutationThreadId }), (old: ThreadRow) =>
                old ? { ...old, language: newLanguage } : old,
            );

            // Also update the composite query cache if it exists
            queryClient.setQueryData(
                // Key derived from the reference; the hand-written literal matched nothing
                // under Lunora, so this optimistic write was never read back.
                crpc.chat.composite.getThreadWithData.queryKey({ messageOpts: DEFAULT_MESSAGE_OPTS, threadId: mutationThreadId as Id<"threads"> }),
                (old: any) => (old?.thread ? { ...old, thread: { ...old.thread, language: newLanguage } } : old),
            );

            return { previousThread };
        },
        onError: (_error, variables, context: { previousThread?: ThreadRow } | undefined) => {
            // Rollback on error
            if (context?.previousThread) {
                queryClient.setQueryData(crpc.chat.functions.getThread.queryKey({ threadId: variables.threadId }), context.previousThread);
            }
        },
    });
    const { data: userSettings } = useUserSettings();
    const setPendingSettings = useModelStore((state) => state.setPendingSettings);
    const pendingSettings = useModelStore((state) => state.pendingSettings);

    const threadLanguage = (threadData as { language?: string } | undefined)?.language;
    const userLanguage = userSettings?.language as string | undefined;

    // Use state for navigator language to avoid hydration mismatch
    // Server renders with undefined, client updates after mount
    const [navigatorLanguage, setNavigatorLanguage] = useState<string | undefined>(undefined);

    useEffect(() => {
        // Only set navigator language on client after hydration
        if (typeof navigator !== "undefined" && navigator.language) {
            setNavigatorLanguage(mapNavigatorLanguage(navigator.language));
        }
    }, []);

    // Priority: pending language (for new threads) > thread language > user language > navigator language > default
    const selectedLanguage = pendingSettings?.language || threadLanguage || userLanguage || navigatorLanguage || "en-US";
    // Create language list with translated labels using shared utility
    const languages = useMemo(() => createLanguageList(i18n, t), [i18n, t]);

    // Find the selected language object
    const selectedLanguageItem = useMemo(
        () => languages.find((l) => l.value === selectedLanguage) || languages[0] || { label: t`English (US)`, value: "en-US" },
        [languages, selectedLanguage, t],
    );

    const handleLanguageChange = useCallback(
        (languageItem: { label: string; value: string } | null) => {
            if (!languageItem) {
                return;
            }

            const languageCode = languageItem.value;

            // For new threads (no valid threadId), store in pending settings
            if (!validThreadId) {
                setPendingSettings((previous) => {
                    return {
                        ...previous,
                        language: languageCode,
                    };
                });

                return;
            }

            // For existing threads, update directly
            updateThreadLanguage({
                language: languageCode,
                threadId: validThreadId,
            });
        },
        [validThreadId, updateThreadLanguage, setPendingSettings],
    );

    return (
        <Combobox items={languages} onValueChange={handleLanguageChange} value={selectedLanguageItem}>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <ComboboxTrigger
                            render={
                                <Button
                                    className="bg-sidebar border-border dark:border-sidebar-border/15 hover:bg-accent/50 dark:hover:bg-sidebar-accent/30 hover:border-border dark:hover:border-sidebar-border/50 text-foreground h-7 justify-between gap-1 px-2 dark:text-white"
                                    size="sm"
                                    variant="outline"
                                />
                            }
                        >
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                <Globe className="size-3 shrink-0" />
                                <ComboboxValue />
                            </div>
                            <ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </ComboboxTrigger>
                    }
                />
                <TooltipContent side="bottom">
                    {t`Select the language for AI responses. This determines which language the assistant will use when generating replies.`}
                </TooltipContent>
            </Tooltip>
            <ComboboxPopup
                aria-label={t`Select response language`}
                style={
                    {
                        "--anchor-width": "300px",
                    } as React.CSSProperties
                }
            >
                <div className="border-b p-2">
                    <ComboboxInput
                        className="rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
                        placeholder={t`Search languages...`}
                        showTrigger={false}
                        size="sm"
                        startAddon={<SearchIcon className="size-3" />}
                    />
                </div>
                <ComboboxEmpty>{t`No languages found`}</ComboboxEmpty>
                <ComboboxList>
                    {(item: { label: string; value: string }) => (
                        <ComboboxItem key={item.value} value={item}>
                            {item.label}
                        </ComboboxItem>
                    )}
                </ComboboxList>
            </ComboboxPopup>
        </Combobox>
    );
};

export default ComposerLanguageSelector;
