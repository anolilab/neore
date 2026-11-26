"use client";

import { useLingui } from "@lingui/react/macro";
import { ANONYMOUS_FREE_MODEL } from "@neore/ai/constants";
import { enabledModelOf } from "@neore/ai/models";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import { Button } from "@neore/ui/components/button";
import { Sidebar, SidebarContent, SidebarFooter, SidebarInset, SidebarProvider, SidebarTrigger } from "@neore/ui/components/sidebar";
import ModeToggle from "@neore/ui/components/theme-toggle";
import cn from "@neore/ui/utils/cn";
import {
    ChevronsUpDownIcon,
    Cog,
    DownloadIcon,
    FolderPlus,
    Globe,
    HelpCircle,
    HourglassIcon,
    ListFilter,
    LogIn,
    Search,
    SquarePen,
    UserRound,
} from "lucide-react";
import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useState } from "react";

import Neore from "@/assets/logo/neore.svg?react";
import { openLoginPrompt } from "@/features/auth/stores/login-prompt-store";
import { holdForSignIn } from "@/features/chat/core/hooks/use-pending-send";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { createLanguageList, mapNavigatorLanguage } from "@/features/chat/core/utils/language-utilities";
import { ComposerModeSwitcher } from "@/features/chat/thread/composer";
import { ComposerBase } from "@/features/chat/thread/composer-base";
import ComposerInputArea from "@/features/chat/thread/composer-input-area";
import ComposerSearchMode from "@/features/chat/thread/composer-search-mode";
import ThreadWelcome from "@/features/chat/thread/thread-welcome";
import ThreadWelcomeSuggestions from "@/features/chat/thread/thread-welcome-suggestions";
import { NAV_LINK_DEFS } from "@/features/layout/components/sidebar-shortcut";
import SiteHeader from "@/features/layout/components/site-header";

import { chatDefaultOpen, chatSidebarNames, chatSidebarStyle } from "../shell-layout";

/**
 * `/chat` for a visitor who is not signed in while registration is invite-only
 * (guests are refused, see `backend/lunora/auth/sign-in-methods.ts`). It draws
 * the signed-in chat's chrome from STATIC data: the rail, the thread-list
 * dock, the chat header, the welcome suggestions and the composer with its
 * toolbar. Nothing here reads account data or calls the backend; every control
 * that would need an account opens the sign-in prompt instead. Sending holds
 * the message for after sign-in (`pending-send.ts`).
 *
 * Classes are copied from the components they stand in for (`SidebarShortcut`,
 * `ThreadListDock`, `ChatSiteHeader`, `Composer`), which read the session,
 * settings or the model catalog; keep them in step.
 */

/** Same width the thread uses (`Thread`'s default `maxWidth`). */
const THREAD_MAX_WIDTH = { "--thread-max-width": "65ch" } as CSSProperties;

/** What a guest would have chatted with; its context window as the gateway reports it. */
const SIGNED_OUT_MODEL = enabledModelOf(ANONYMOUS_FREE_MODEL, { mode: "text" });
const SIGNED_OUT_CONTEXT = "128K";

const RAIL_ITEM = "group relative flex size-10 items-center justify-center rounded-[10px] transition-colors duration-150";
const RAIL_IDLE = "text-muted-foreground hover:bg-surface-row-hover hover:text-foreground";
const DOCK_ICON = "text-muted-foreground hover:text-foreground size-[30px] p-0";
const TOOLBAR_BUTTON =
    "bg-sidebar border-border dark:border-sidebar-border/15 hover:bg-accent/50 dark:hover:bg-sidebar-accent/30 hover:border-border dark:hover:border-sidebar-border/50 text-foreground h-7 dark:text-white";

/**
 * Opens the sign-in prompt from a control the visitor needs an account for. The control keeps focus, so closing the
 * prompt returns focus to it (the dialog restores focus to what had it when it opened).
 */
export const askToSignIn = (): void => {
    openLoginPrompt();
};

/** `SidebarShortcut`'s rail: the entries a guest would see, the settings, help and account buttons. */
const SignedOutRail: FC = () => {
    const { t } = useLingui();
    const links = NAV_LINK_DEFS.filter((definition) => !definition.requiresAuth && !definition.featureFlag);

    return (
        <div className="z-20 hidden h-dvh w-16 shrink-0 md:block">
            <div className="bg-surface-rail text-foreground flex h-full flex-col items-center shadow-[inset_-1px_0_0_var(--surface-edge)]">
                <Neore
                    className="fill-brand-black dark:fill-brand-white mt-3 mb-4 size-7 opacity-90 transition-opacity hover:opacity-70"
                    title={t`Neore - AI Text & Video & Audio & Image & Documents Generation Platform`}
                />

                <div className="mt-4 flex flex-col gap-1">
                    {links.map(({ icon: Icon, labelKey, to }) => {
                        const isChat = to === "/chat";

                        return (
                            <button
                                aria-current={isChat ? "page" : undefined}
                                aria-label={t(labelKey)}
                                className={cn(RAIL_ITEM, isChat ? "bg-surface-row-active surface-edge text-foreground" : RAIL_IDLE)}
                                key={to}
                                onClick={isChat ? undefined : askToSignIn}
                                type="button"
                            >
                                <Icon className="text-brand-black dark:text-brand-white size-5" strokeWidth={1.5} />
                            </button>
                        );
                    })}
                </div>

                <div className="mt-auto mb-2 flex flex-col items-center gap-1">
                    <button aria-label={t`Open Settings`} className={cn(RAIL_ITEM, RAIL_IDLE)} onClick={askToSignIn} type="button">
                        <Cog className="size-5" strokeWidth={1.5} />
                    </button>
                    <button aria-label={t`Help`} className={cn(RAIL_ITEM, RAIL_IDLE)} onClick={askToSignIn} type="button">
                        <HelpCircle className="size-5" strokeWidth={1.5} />
                    </button>
                    <button aria-label={t`Open user menu`} className={cn(RAIL_ITEM, "hover:bg-surface-row-hover")} onClick={askToSignIn} type="button">
                        <UserRound className="text-brand-black dark:text-brand-white size-5" strokeWidth={1.5} />
                    </button>
                </div>
            </div>
        </div>
    );
};

/** `ThreadListDock`: the search field, the filter menu, Add project and New Thread in one raised row, each asking to sign in. */
const SignedOutThreadListDock: FC = () => {
    const { t } = useLingui();

    return (
        <div className="surface-raised flex w-full items-center gap-0.5 rounded-[14px] p-1">
            <button
                aria-label={t`Search threads`}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2.5 text-[13.5px] focus-visible:ring-2 focus-visible:outline-none"
                onClick={askToSignIn}
                type="button"
            >
                <Search aria-hidden="true" className="size-4 shrink-0" />
                <span aria-hidden="true" className="truncate">
                    {t`Search`}
                </span>
            </button>
            <Button aria-label={t`Search filters`} className={DOCK_ICON} onClick={askToSignIn} size="sm" variant="ghost">
                <ListFilter aria-hidden="true" className="size-4" />
            </Button>
            <Button aria-label={t`Add project`} className={DOCK_ICON} onClick={askToSignIn} size="sm" variant="ghost">
                <FolderPlus aria-hidden="true" className="size-4" />
            </Button>
            <Button aria-label={t`New Thread`} className="text-foreground size-[30px] p-0" onClick={askToSignIn} size="sm" variant="ghost">
                <SquarePen aria-hidden="true" className="size-4" />
            </Button>
        </div>
    );
};

/** The composer's bottom row (`Composer`'s `bottomToolbar`) with the free model, no context used and the browser's language. */
const SignedOutComposerToolbar: FC = () => {
    const { i18n, t } = useLingui();
    // Read after mount, as `ComposerLanguageSelector` does, so the server and first client render agree.
    const [language, setLanguage] = useState("en-US");

    useEffect(() => {
        if (typeof navigator !== "undefined" && navigator.language) {
            setLanguage(mapNavigatorLanguage(navigator.language));
        }
    }, []);

    const languages = createLanguageList(i18n, t);
    const languageLabel = (languages.find((item) => item.value === language) ?? languages[0])?.label ?? t`English (US)`;

    return (
        <>
            <Button className={cn("w-[200px] justify-between", TOOLBAR_BUTTON)} onClick={askToSignIn} size="sm" variant="outline">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    {SIGNED_OUT_MODEL && (
                        <ProviderIcon
                            className="size-3"
                            provider={SIGNED_OUT_MODEL.provider || SIGNED_OUT_MODEL.displayProvider || ""}
                            providerIcon={SIGNED_OUT_MODEL.id.split("/", 1)[0] || SIGNED_OUT_MODEL.displayProvider || ""}
                        />
                    )}
                    <span className="truncate">{SIGNED_OUT_MODEL?.name ?? ANONYMOUS_FREE_MODEL}</span>
                </div>
                <ChevronsUpDownIcon aria-hidden="true" className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
            <ComposerSearchMode mode="chat" onModeChange={() => openLoginPrompt()} />
            <div className="grow" />
            <div aria-label={t`Context Usage`} className="text-muted-foreground flex items-center gap-1.5 text-xs" role="img">
                <div className="flex size-4 items-center justify-center">
                    <svg aria-hidden="true" className="-rotate-90 transform" height={16} width={16}>
                        <circle cx={8} cy={8} fill="none" r={6.75} stroke="var(--muted)" strokeWidth={2.5} />
                    </svg>
                </div>
                <span className="tabular-nums">0/{SIGNED_OUT_CONTEXT}</span>
            </div>
            <Button className={cn("justify-between gap-1 px-2", TOOLBAR_BUTTON)} onClick={askToSignIn} size="sm" variant="outline">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Globe aria-hidden="true" className="size-3 shrink-0" />
                    <span>{languageLabel}</span>
                </div>
                <ChevronsUpDownIcon aria-hidden="true" className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
        </>
    );
};

/**
 * The composer a signed-out visitor sees: the chat composer's container, suggestions, input row and toolbar.
 * Sending keeps the draft, holds it for after sign-in (`pending-send.ts`) and opens the sign-in prompt. The draft
 * lives in the chat store, so the signed-in composer shows it too.
 */
export const SignedOutComposer: FC = () => {
    const { t } = useLingui();
    const text = useChatUIStore((state) => state.composerText);
    const setText = useChatUIStore((state) => state.setComposerText);

    const handleSubmit = useCallback(() => {
        const { composerDraftFrom, composerText: draft } = useChatUIStore.getState();

        if (!draft.trim()) {
            return;
        }

        // A picked suggestion keeps its mark through the sign-in, a redirect's reload included (`draft-origin.ts`).
        holdForSignIn(draft, composerDraftFrom);
    }, []);

    return (
        <div className="relative w-full">
            {/* Filling the draft from a suggestion needs no account; sending it asks for one. */}
            <ThreadWelcomeSuggestions className="-mb-5 pb-5.5" />
            <ComposerBase
                bottomToolbar={<SignedOutComposerToolbar />}
                leftPanel={<ComposerModeSwitcher mode="text" onModeChange={() => openLoginPrompt()} />}
                mode="text"
            >
                <ComposerInputArea
                    onAddAttachment={openLoginPrompt}
                    onChange={setText}
                    onSubmit={handleSubmit}
                    placeholder={t`Type your message...`}
                    suggestions={false}
                    value={text}
                />
            </ComposerBase>
        </div>
    );
};

const SignedOutChat: FC = () => {
    const { t } = useLingui();

    return (
        <SidebarProvider defaultOpen={chatDefaultOpen} sidebarNames={chatSidebarNames} style={chatSidebarStyle}>
            <div className="flex h-dvh w-full">
                <SignedOutRail />
                <Sidebar className="left-16 [--sidebar-offset:4rem] [&>div]:flex-row" collapsible="offcanvas" name="left" variant="inset">
                    <div className="bg-sidebar relative z-10 flex w-(--sidebar-width) flex-col rounded-l-xl">
                        <SidebarContent>
                            {/* `HierarchicalThreadList`'s empty state, worded for a visitor who has no threads to load. */}
                            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                                <p className="text-muted-foreground">{t`No threads yet`}</p>
                                <p className="text-muted-foreground text-xs">{t`Sign in to see your chats.`}</p>
                            </div>
                        </SidebarContent>
                        <SidebarFooter className="items-stretch gap-2 p-3">
                            <SignedOutThreadListDock />
                            <button
                                className="bg-primary text-primary-foreground hover:bg-primary/90 flex w-full items-center gap-2 rounded-lg px-3 py-2 transition-colors"
                                onClick={askToSignIn}
                                type="button"
                            >
                                <LogIn aria-hidden="true" className="size-4" />
                                <span className="w-full text-center">{t`Login`}</span>
                            </button>
                        </SidebarFooter>
                    </div>
                </Sidebar>
                <SidebarInset className="md:peer-data-[variant=inset]:m-1">
                    <SiteHeader
                        menu={
                            <Button onClick={askToSignIn} size="icon" variant="ghost">
                                <DownloadIcon className="h-4 w-4" />
                                <span className="sr-only">{t`Export chat`}</span>
                            </Button>
                        }
                        themeToggle={
                            <>
                                <Button aria-label={t`Temporary Chat`} className="text-foreground" onClick={askToSignIn} size="icon" variant="ghost">
                                    <HourglassIcon aria-hidden="true" className="size-4" />
                                </Button>
                                <ModeToggle className="text-foreground" />
                            </>
                        }
                        title={t`New Chat`}
                        trigger={<SidebarTrigger className="ml-2" name="left" />}
                        workspaceSwitch
                    />
                    <div className="relative h-[calc(100%-40px)]" style={THREAD_MAX_WIDTH}>
                        <div className="flex h-full flex-col items-center overflow-y-auto bg-inherit px-4 pt-2">
                            <div className="flex min-h-full w-full max-w-(--thread-max-width) flex-col">
                                <div className="flex flex-1 flex-col items-center justify-center">
                                    <ThreadWelcome />
                                </div>
                                <div className="sticky bottom-0 mx-auto flex w-full flex-col items-center justify-end bg-inherit">
                                    <SignedOutComposer />
                                </div>
                            </div>
                        </div>
                    </div>
                </SidebarInset>
            </div>
        </SidebarProvider>
    );
};

export default SignedOutChat;
