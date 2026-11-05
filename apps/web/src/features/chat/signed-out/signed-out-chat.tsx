"use client";

import { useLingui } from "@lingui/react/macro";
import { Sidebar, SidebarContent, SidebarFooter, SidebarInset, SidebarProvider, SidebarTrigger } from "@neore/ui/components/sidebar";
import ModeToggle from "@neore/ui/components/theme-toggle";
import { LogIn } from "lucide-react";
import type { CSSProperties, FC } from "react";
import { useCallback } from "react";

import Neore from "@/assets/logo/neore.svg?react";
import { openLoginPrompt } from "@/features/auth/stores/login-prompt-store";
import { holdForSignIn } from "@/features/chat/core/hooks/use-pending-send";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { ComposerBase } from "@/features/chat/thread/composer-base";
import ComposerInputArea from "@/features/chat/thread/composer-input-area";
import ThreadWelcome from "@/features/chat/thread/thread-welcome";
import SiteHeader from "@/features/layout/components/site-header";

import { chatDefaultOpen, chatSidebarNames, chatSidebarStyle } from "../shell-layout";

/** Same width the thread uses (`Thread`'s default `maxWidth`). */
const THREAD_MAX_WIDTH = { "--thread-max-width": "65ch" } as CSSProperties;

/**
 * The composer a signed-out visitor sees: the chat composer's own container and
 * input row, with nothing that needs an account (no attachments, no model
 * picker, no slash commands or @ mentions). Sending keeps the draft, remembers
 * it for after sign-in (`pending-send.ts`) and opens the sign-in prompt. The
 * draft lives in the chat store, so the signed-in composer shows it too.
 */
export const SignedOutComposer: FC = () => {
    const { t } = useLingui();
    const text = useChatUIStore((state) => state.composerText);
    const setText = useChatUIStore((state) => state.setComposerText);

    const handleSubmit = useCallback(() => {
        const draft = useChatUIStore.getState().composerText;

        if (!draft.trim()) {
            return;
        }

        holdForSignIn(draft);
    }, []);

    return (
        <div className="relative w-full">
            <div className="text-foreground absolute top-full w-full pt-2 text-center text-xs">{t`Neore can make mistakes. Check important information.`}</div>
            <ComposerBase mode="text">
                <ComposerInputArea onChange={setText} onSubmit={handleSubmit} placeholder={t`Type your message...`} suggestions={false} value={text} />
            </ComposerBase>
        </div>
    );
};

/**
 * `/chat` for a visitor who is not signed in while registration is invite-only
 * (guests are refused, see `backend/lunora/auth/sign-in-methods.ts`). The same
 * shell as the signed-in chat (rail, sidebar, header, new-chat greeting,
 * composer) built from parts that read no account data, so it makes no backend
 * calls of its own. Sending asks the visitor to sign in; the message is sent
 * once they have.
 */
const SignedOutChat: FC = () => {
    const { t } = useLingui();

    return (
        <SidebarProvider defaultOpen={chatDefaultOpen} sidebarNames={chatSidebarNames} style={chatSidebarStyle}>
            <div className="flex h-dvh w-full">
                {/* Mirrors SidebarShortcut's geometry; its links and usage meter need an account. */}
                <div className="z-20 hidden h-dvh w-16 shrink-0 py-1 pl-1 md:block">
                    <div className="bg-sidebar dark:bg-brand-obsidian ring-sidebar-border flex h-full flex-col items-center rounded-lg ring-1">
                        <Neore
                            className="fill-brand-black dark:fill-brand-white mt-3 mb-4 size-7 opacity-90"
                            title={t`Neore - AI Text & Video & Audio & Image & Documents Generation Platform`}
                        />
                    </div>
                </div>
                <Sidebar className="left-16 [&>div]:flex-row" collapsible="offcanvas" name="left" variant="inset">
                    <div className="relative z-10 flex w-(--sidebar-width) flex-col rounded-l-xl">
                        <SidebarContent>
                            <p className="text-muted-foreground px-4 pt-6 text-center text-sm">{t`Sign in to see your chats.`}</p>
                        </SidebarContent>
                        <SidebarFooter>
                            <button
                                className="bg-primary text-primary-foreground hover:bg-primary/90 flex w-full items-center gap-2 rounded-lg px-3 py-2 transition-colors"
                                onClick={(event) => {
                                    event.currentTarget.blur();
                                    openLoginPrompt();
                                }}
                                type="button"
                            >
                                <LogIn aria-hidden="true" className="size-4" />
                                <span className="w-full text-center">{t`Login`}</span>
                            </button>
                        </SidebarFooter>
                    </div>
                </Sidebar>
                <SidebarInset className="dark:bg-brand-obsidian md:peer-data-[variant=inset]:m-1">
                    <SiteHeader
                        themeToggle={<ModeToggle className="text-foreground" />}
                        title={t`New Chat`}
                        trigger={<SidebarTrigger className="ml-2" name="left" />}
                    />
                    <div className="relative h-[calc(100%-40px)]" style={THREAD_MAX_WIDTH}>
                        <div className="flex h-full flex-col items-center overflow-y-auto bg-inherit px-4 pt-2">
                            <div className="flex min-h-full w-full max-w-(--thread-max-width) flex-col">
                                <div className="flex flex-1 flex-col items-center justify-center">
                                    <ThreadWelcome />
                                </div>
                                <div className="sticky bottom-0 mx-auto flex w-full flex-col items-center justify-end bg-inherit pb-12 sm:pb-8">
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
