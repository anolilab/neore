import { AlertCircleIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AuthPage } from "@/features/auth/AuthPage";
import { ChatPage } from "@/features/chat/ChatPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { ThreadsPage } from "@/features/threads/ThreadsPage";
import type { ChatSeed, View } from "@/features/types";
import { useSession } from "@/lib/session";
import { browserLanguage, readSettings } from "@/lib/settings";
import type { PanelRequest } from "@/page-context/panel-request";
import { subscribePanelRequests } from "@/page-context/panel-request";
import { languageName, quickPrompt } from "@/page-context/quick-prompts";

const newChat = (seed?: ChatSeed): View => {
    return { key: crypto.randomUUID(), seed, threadId: null, type: "chat" };
};

/** Turn a background request into the chat it should open. */
const seedFor = async (request: Exclude<PanelRequest, { kind: "error" }>): Promise<ChatSeed> => {
    if (request.kind === "attach-page") {
        return { id: request.id, pageContext: request.context };
    }

    const { translateLanguage } = await readSettings();

    return {
        autoSend: quickPrompt(request.action, languageName(translateLanguage ?? browserLanguage())),
        id: request.id,
        pageContext: request.context,
    };
};

export default function App() {
    const { data: session, isPending } = useSession();
    const [view, setView] = useState<View>({ type: "threads" });
    const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
    const [notice, setNotice] = useState<string>();
    const isSignedIn = Boolean(session);

    // Context-menu and shortcut requests from the background worker. Only taken
    // once signed in, so a request made while signed out waits for sign-in.
    useEffect(() => {
        if (!isSignedIn) {
            return undefined;
        }

        return subscribePanelRequests((request) => {
            if (request.kind === "error") {
                setNotice(request.message);

                return;
            }

            setNotice(undefined);
            void seedFor(request).then((seed) => setView(newChat(seed)));
        });
    }, [isSignedIn]);

    const onThreadCreated = useCallback((threadId: string) => {
        setView((current) => (current.type === "chat" ? { ...current, threadId } : current));
    }, []);

    if (isPending) {
        return (
            <div className="flex h-screen items-center justify-center" role="status">
                <span className="sr-only">Loading</span>
                <div aria-hidden="true" className="size-8 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
            </div>
        );
    }

    if (!isSignedIn) {
        return <AuthPage />;
    }

    let page;

    if (view.type === "chat") {
        page = (
            <ChatPage key={view.key} onBack={() => setView({ type: "threads" })} onThreadCreated={onThreadCreated} seed={view.seed} threadId={view.threadId} />
        );
    } else if (view.type === "settings") {
        page = <SettingsPage onBack={() => setView({ type: "threads" })} />;
    } else {
        page = (
            <ThreadsPage
                activeOrgId={activeOrgId}
                onNewChat={() => setView(newChat())}
                onOpenSettings={() => setView({ type: "settings" })}
                onSelectThread={(threadId) => setView({ key: threadId, threadId, type: "chat" })}
                setActiveOrgId={setActiveOrgId}
            />
        );
    }

    return (
        <div className="flex h-screen flex-col bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-50">
            {notice && (
                <div
                    className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
                    role="alert"
                >
                    <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    <p className="flex-1">{notice}</p>
                    <button
                        aria-label="Dismiss"
                        className="flex size-5 shrink-0 items-center justify-center rounded focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none"
                        onClick={() => setNotice(undefined)}
                        type="button"
                    >
                        <XIcon aria-hidden="true" className="size-3.5" />
                    </button>
                </div>
            )}
            <div className="min-h-0 flex-1">{page}</div>
        </div>
    );
}
