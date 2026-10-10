import { useQuery } from "@lunora/react";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import ChatView from "@neore/chat-ui/chat/chat-view";
import DocumentArtifact from "@neore/chat-ui/chat/document-artifact";
import McpAppView from "@neore/chat-ui/chat/mcp-app-view";
import PresentationArtifact from "@neore/chat-ui/chat/presentation-artifact";
import { AlertCircleIcon, FilePlus2Icon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { LUNORA_URL } from "@/lib/env";
import { useSettings } from "@/lib/settings";
import type { PageContext } from "@/page-context/build";
import { PageContextError } from "@/page-context/build";
import { capturePage } from "@/page-context/capture";

import { useModels } from "../models/use-models";
import type { ChatSeed } from "../types";
import { PageContextChip } from "./PageContextChip";
import { useChat } from "./use-chat";

interface ChatPageProps {
    onBack: () => void;
    onThreadCreated: (threadId: string) => void;
    seed?: ChatSeed;
    threadId: string | null;
}

const components = {
    DocumentArtifact,
    // MCP App proxy calls go to the backend's HTTP routes on the Lunora Worker.
    McpApp: LUNORA_URL ? (props: Omit<Parameters<typeof McpAppView>[0], "lunoraSiteUrl">) => <McpAppView {...props} lunoraSiteUrl={LUNORA_URL} /> : undefined,
    PresentationArtifact,
};

export function ChatPage({ onBack, onThreadCreated, seed, threadId }: ChatPageProps) {
    const settings = useSettings();
    const models = useModels();
    const thread = useQuery(api.chat.functions.getThread, threadId ? { threadId: threadId as Id<"threads"> } : "skip");

    const [chosenModelId, setChosenModelId] = useState<string>();
    const modelId = chosenModelId ?? thread?.model ?? settings?.defaultModelId ?? DEFAULT_CHAT_MODEL;

    const [attached, setAttached] = useState<PageContext | undefined>(seed?.pageContext);
    const [captureStatus, setCaptureStatus] = useState<{ error?: string; pending: boolean }>({ pending: false });
    const [draft, setDraft] = useState<{ id: number; text: string }>();

    const { error, hasMore, isSending, isStreaming, loadMore, messages, send } = useChat(threadId, onThreadCreated);

    const handleSend = useCallback(
        async (text: string) => {
            const sent = await send({ modelId, pageContext: attached, text });

            if (sent) {
                setAttached(undefined);
            } else {
                // Put the text back so a failed send does not lose what was typed.
                setDraft((current) => {
                    return { id: (current?.id ?? 0) + 1, text };
                });
            }
        },
        [attached, modelId, send],
    );

    // A new seed (context menu, shortcut) replaces the attachment; a quick prompt
    // sends straight away, once settings have loaded and decided the model.
    const handledSeed = useRef<string | undefined>(undefined);

    useEffect(() => {
        if (!seed || handledSeed.current === seed.id || settings === undefined) {
            return;
        }

        handledSeed.current = seed.id;
        setAttached(seed.pageContext);
        setCaptureStatus({ pending: false });

        if (seed.autoSend) {
            const { autoSend, pageContext } = seed;

            const sendSeed = async () => {
                if (await send({ modelId, pageContext, text: autoSend })) {
                    setAttached(undefined);
                }
            };

            void sendSeed();
        }
    }, [modelId, seed, send, settings]);

    const attachCurrentPage = async () => {
        setCaptureStatus({ pending: true });

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab) {
                throw new PageContextError("No active tab.");
            }

            setAttached(await capturePage(tab));
            setCaptureStatus({ pending: false });
        } catch (captureError) {
            setCaptureStatus({
                error: captureError instanceof PageContextError ? captureError.message : "Could not read this page.",
                pending: false,
            });
        }
    };

    const busy = isSending || isStreaming;
    let status = "";

    if (captureStatus.pending) {
        status = "Reading the page…";
    } else if (isSending) {
        status = "Sending…";
    } else if (isStreaming) {
        status = "Anole is replying…";
    }

    const composerSlot = (
        <>
            {/* Announced politely; the visual equivalents are the spinner and chips. */}
            <p aria-live="polite" className="sr-only" role="status">
                {status}
            </p>

            {(error ?? captureStatus.error) && (
                <div
                    className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
                    role="alert"
                >
                    <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    <span>{error ?? captureStatus.error}</span>
                </div>
            )}

            {attached ? (
                <PageContextChip context={attached} onRemove={() => setAttached(undefined)} />
            ) : (
                <div className="mx-3 mt-3">
                    <button
                        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                        disabled={captureStatus.pending || busy}
                        onClick={() => {
                            void attachCurrentPage();
                        }}
                        type="button"
                    >
                        {captureStatus.pending ? (
                            <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
                        ) : (
                            <FilePlus2Icon aria-hidden="true" className="size-3.5" />
                        )}
                        Attach this page
                    </button>
                </div>
            )}
        </>
    );

    return (
        <main className="h-full">
            <ChatView
                availableModels={models}
                components={components}
                composerDraft={draft}
                composerSlot={composerSlot}
                hasMoreMessages={hasMore}
                isStreaming={busy}
                messages={messages}
                onBack={onBack}
                onLoadMoreMessages={loadMore}
                onSelectModel={setChosenModelId}
                onSendMessage={(text) => {
                    void handleSend(text);
                }}
                selectedModelId={modelId}
                thread={{
                    _creationTime: thread?._creationTime ?? 0,
                    _id: threadId ?? "",
                    model: thread?.model,
                    title: thread?.title ?? (threadId ? undefined : "New chat"),
                }}
            />
        </main>
    );
}
