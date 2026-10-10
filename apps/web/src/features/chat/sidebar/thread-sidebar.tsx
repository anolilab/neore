"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Separator } from "@neore/ui/components/separator";
import { Sidebar, SidebarContent, SidebarRail } from "@neore/ui/components/sidebar";
import { Switch } from "@neore/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { Braces, FileText, Loader2, MessageSquare, PinIcon, Sparkles } from "lucide-react";
import type { FC, MouseEvent as ReactMouseEvent } from "react";
import { Activity, useEffect, useRef, useState } from "react";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import useModelCombobox from "@/features/chat/model-settings/use-model-combobox";
import PinsSidebarTab from "@/features/chat/pins/pins-sidebar-tab";
import ApplyPresetMenu from "@/features/chat/prompt-improvement/components/apply-preset-menu";
import SystemPromptOptimizerDialog from "@/features/chat/prompt-improvement/components/system-prompt-optimizer-dialog";
import { RIGHT_SIDEBAR_MAX_WIDTH, RIGHT_SIDEBAR_MIN_WIDTH, useUIStateStore } from "@/features/layout/stores/ui-state-store";
import PromptsSidebarTab from "@/features/prompts/components/prompts-sidebar-tab";
import ThreadVariablesConfig from "@/features/prompts/components/thread-variables-config";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { useCRPC } from "@/lib/lunora/crpc";

interface ThreadSidebarProps {
    threadId?: string;
}

const ThreadSummary: FC<{ threadId?: string }> = ({ threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { thread, updateThread } = useModelCombobox({ threadId });
    const pendingSettings = useModelStore((state) => state.pendingSettings);
    const flaggedModels = useFeatureFlaggedModels();
    const modelsMap = new Map(flaggedModels.map((m) => [m.id, m]));

    // Mutation to generate summary
    const { isPending: isGeneratingSummary, mutate: generateSummary } = useMutation({
        ...crpc.chat.functions.generateSummary.mutationOptions(),
    });

    // Check if the thread model is a text model (summary only works for text models)
    const threadModelDefinition = thread?.model ? modelsMap.get(thread.model) : undefined;
    const isTextModel = !thread?.model || (threadModelDefinition?.mode || "text") === "text";

    const threadStatelessMode = (thread as { statelessMode?: boolean } | undefined)?.statelessMode;
    const threadCustomSystemPrompt = (thread as { customSystemPrompt?: string } | undefined)?.customSystemPrompt;

    const isNewThread = !threadId || threadId === "default" || !thread;

    const effectiveStatelessMode = isNewThread ? pendingSettings?.statelessMode : threadStatelessMode;
    const effectiveCustomSystemPrompt = isNewThread ? pendingSettings?.customSystemPrompt : threadCustomSystemPrompt;

    const [statelessMode, setStatelessMode] = useState<boolean>(effectiveStatelessMode ?? false);
    const [customSystemPrompt, setCustomSystemPrompt] = useState<string>(effectiveCustomSystemPrompt ?? "");
    const [isOptimizerOpen, setIsOptimizerOpen] = useState(false);

    // Reseed the local copies when the thread changes. Adjusted during render
    // rather than in an effect, so the sidebar never paints the previous thread's
    // system prompt.
    const [syncedThreadId, setSyncedThreadId] = useState(threadId);

    if (threadId !== syncedThreadId) {
        setSyncedThreadId(threadId);
        setStatelessMode(effectiveStatelessMode ?? false);
        setCustomSystemPrompt(effectiveCustomSystemPrompt ?? "");
    }

    const handleStatelessModeChange = async (enabled: boolean) => {
        try {
            setStatelessMode(enabled);

            await updateThread({
                statelessMode: enabled,
            });
        } catch (error) {
            console.error("[ThreadSidebar] Failed to update stateless mode:", error);
            setStatelessMode(!enabled);
        }
    };

    const promptTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const handleCustomSystemPromptChange = (value: string) => {
        setCustomSystemPrompt(value);

        if (promptTimeoutRef.current) {
            clearTimeout(promptTimeoutRef.current);
        }

        promptTimeoutRef.current = setTimeout(() => {
            updateThread({ customSystemPrompt: value || undefined });
            promptTimeoutRef.current = null;
        }, 500);
    };

    const handleOptimizedSystemPrompt = async (optimized: string) => {
        const trimmed = optimized.trim();

        setCustomSystemPrompt(trimmed);
        await updateThread({ customSystemPrompt: trimmed || undefined });
    };

    useEffect(
        () => () => {
            if (promptTimeoutRef.current) {
                clearTimeout(promptTimeoutRef.current);
            }
        },
        [],
    );

    const handleGenerateSummary = () => {
        if (threadId && isTextModel) {
            // `threadId` is the `/chat/$threadId` route param, passed down as a plain string.
            generateSummary({ threadId: threadId as Id<"threads"> });
        }
    };

    return (
        <div className="space-y-5 py-4 pr-2 pl-1">
            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <h2 className="text-foreground text-base font-semibold">{t`Thread summary`}</h2>
                    {threadId && isTextModel && (
                        <Button className="h-7 gap-1.5 px-2 text-xs" disabled={isGeneratingSummary} onClick={handleGenerateSummary} size="sm" variant="ghost">
                            {isGeneratingSummary ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                            {isGeneratingSummary ? t`Generating...` : t`Generate`}
                        </Button>
                    )}
                </div>
                <div className="text-foreground/70 border-sidebar-border bg-sidebar-accent/30 rounded-md border p-3 text-sm leading-relaxed">
                    {isTextModel ? (
                        <p className="whitespace-pre-line">{thread?.summary || t`No summary available. Click "Generate" to create one.`}</p>
                    ) : (
                        <p className="text-muted-foreground italic">{t`Summary is only available for text models.`}</p>
                    )}
                </div>
            </div>

            <Separator />

            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex flex-col gap-1">
                        <Label className="text-foreground text-sm font-medium">{t`Stateless Mode`}</Label>
                        <p className="text-muted-foreground text-xs">
                            {t`Process each message independently with only the system prompt and current input. No chat history context.`}
                        </p>
                    </div>
                    <Switch checked={statelessMode} onCheckedChange={handleStatelessModeChange} />
                </div>

                <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <Label className="text-foreground text-sm font-medium" htmlFor="custom-system-prompt">
                            {t`Custom System Prompt`}
                        </Label>
                        <div className="flex items-center gap-2">
                            <ApplyPresetMenu modelId={thread?.model} onApply={handleOptimizedSystemPrompt} />
                            <Button onClick={() => setIsOptimizerOpen(true)} size="sm" type="button" variant="outline">
                                <Sparkles aria-hidden="true" className="mr-1.5 size-3.5" />
                                {t`Optimize`}
                            </Button>
                        </div>
                    </div>
                    <Textarea
                        expandable
                        expandableDialogTitle={t`Custom System Prompt`}
                        id="custom-system-prompt"
                        onBlur={(e) => {
                            if (promptTimeoutRef.current) {
                                clearTimeout(promptTimeoutRef.current);
                                promptTimeoutRef.current = null;
                            }

                            updateThread({ customSystemPrompt: e.target.value || undefined });
                        }}
                        onChange={(e) => {
                            handleCustomSystemPromptChange(e.target.value);
                        }}
                        placeholder={t`Enter your custom system prompt here. This will be used for every message.`}
                        value={customSystemPrompt}
                    />
                    <p className="text-muted-foreground text-xs">
                        {statelessMode
                            ? t`This prompt will be used for every message. Each message is processed independently without chat history.`
                            : t`This prompt will be used for every message alongside the conversation history.`}
                    </p>
                </div>
            </div>
            <SystemPromptOptimizerDialog
                initialPrompt={customSystemPrompt}
                modelId={thread?.model}
                onApply={handleOptimizedSystemPrompt}
                onOpenChange={setIsOptimizerOpen}
                open={isOptimizerOpen}
                threadId={threadId}
                title={t`Optimize thread system prompt`}
            />
        </div>
    );
};

// Minimum center content width to always keep visible
const MIN_CENTER_WIDTH = 320;
// Left sidebar width from route.tsx: calc(var(--spacing) * 66) = 264px
const LEFT_SIDEBAR_WIDTH = 264;

const SidebarResizeHandle: FC = () => {
    const setRightSidebarWidth = useUIStateStore((s) => s.setRightSidebarWidth);
    const isLeftSidebarOpen = useUIStateStore((s) => s.sidebars["left"]?.isOpen ?? true);

    const handleMouseDown = (e: ReactMouseEvent) => {
        e.preventDefault();

        // Compute effective max before drag starts so it's stable during the gesture
        const occupiedByLeft = isLeftSidebarOpen ? LEFT_SIDEBAR_WIDTH : 0;
        const effectiveMax = Math.min(RIGHT_SIDEBAR_MAX_WIDTH, window.innerWidth - occupiedByLeft - MIN_CENTER_WIDTH);

        let lastWidth = 0;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            const newWidth = Math.min(effectiveMax, Math.max(RIGHT_SIDEBAR_MIN_WIDTH, window.innerWidth - moveEvent.clientX));

            lastWidth = newWidth;
            // Direct DOM update avoids React re-renders during drag
            const wrapper = document.querySelector("[data-sidebar-right-wrapper]") as HTMLElement | null;

            if (wrapper) {
                wrapper.style.setProperty("--sidebar-width", `${newWidth}px`);
            }
        };

        const handleMouseUp = () => {
            if (lastWidth > 0) {
                setRightSidebarWidth(lastWidth);
            }

            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
        };

        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
    };

    return (
        <div
            aria-hidden="true"
            className="hover:bg-sidebar-border/60 active:bg-sidebar-border absolute top-0 left-0 z-50 h-full w-1 cursor-col-resize transition-colors"
            onMouseDown={handleMouseDown}
        />
    );
};

const ThreadSidebar: FC<ThreadSidebarProps> = ({ threadId }) => {
    const { t } = useLingui();
    const activeRightSidebarTab = useChatUIStore((state) => state.activeRightSidebarTab);
    const setActiveRightSidebarTab = useChatUIStore((state) => state.setActiveRightSidebarTab);
    const flaggedModels = useFeatureFlaggedModels();
    const modelsMap = new Map(flaggedModels.map((m) => [m.id, m]));

    const { thread } = useModelCombobox({ threadId });
    const isTextModel = !thread?.model || (modelsMap.get(thread.model)?.mode ?? "text") === "text";

    return (
        <Sidebar className="py-1 [&>div]:rounded-l-xl" collapsible="offcanvas" name="right" side="right" variant="inset">
            <SidebarResizeHandle />
            <SidebarContent className="overflow-hidden">
                <Tabs className="flex min-h-0 flex-1 flex-col" onValueChange={setActiveRightSidebarTab} value={activeRightSidebarTab}>
                    <div className="px-1">
                        <TabsList className="bg-sidebar-accent/50 dark:bg-sidebar-accent/30 border-sidebar-border/50 w-full border" variant="default">
                            <TabsTrigger
                                className="text-brand-black/70 dark:text-brand-white/70 hover:text-brand-black hover:dark:text-brand-white data-active:text-brand-black data-active:dark:text-brand-white"
                                value="summary"
                            >
                                <MessageSquare className="mr-1.5 size-3.5" />
                                {t`Thread`}
                            </TabsTrigger>
                            <TabsTrigger
                                className="text-brand-black/70 dark:text-brand-white/70 hover:text-brand-black hover:dark:text-brand-white data-active:text-brand-black data-active:dark:text-brand-white"
                                value="prompts"
                            >
                                <FileText className="mr-1.5 size-3.5" />
                                {t`Prompts`}
                            </TabsTrigger>
                            <TabsTrigger
                                className="text-brand-black/70 dark:text-brand-white/70 hover:text-brand-black hover:dark:text-brand-white data-active:text-brand-black data-active:dark:text-brand-white"
                                value="variables"
                            >
                                <Braces className="mr-1.5 size-3.5" />
                                {t`Variables`}
                            </TabsTrigger>
                            {isTextModel && (
                                <TabsTrigger
                                    className="text-brand-black/70 dark:text-brand-white/70 hover:text-brand-black hover:dark:text-brand-white data-active:text-brand-black data-active:dark:text-brand-white"
                                    value="pins"
                                >
                                    <PinIcon className="mr-1.5 size-3.5" />
                                    {t`Pins`}
                                </TabsTrigger>
                            )}
                        </TabsList>
                    </div>
                    {/* Relative wrapper gives all tabs the same absolute bounds */}
                    <div className="relative min-h-0 flex-1 overflow-hidden">
                        <Activity mode={activeRightSidebarTab === "summary" ? "visible" : "hidden"}>
                            <TabsContent className="absolute inset-0 overflow-y-auto text-xs/relaxed outline-none" value="summary">
                                <ThreadSummary threadId={threadId} />
                            </TabsContent>
                        </Activity>
                        <Activity mode={activeRightSidebarTab === "prompts" ? "visible" : "hidden"}>
                            <TabsContent className="absolute inset-0 overflow-y-auto" value="prompts">
                                <PromptsSidebarTab threadId={threadId} />
                            </TabsContent>
                        </Activity>
                        <Activity mode={activeRightSidebarTab === "variables" ? "visible" : "hidden"}>
                            <TabsContent className="absolute inset-0 overflow-y-auto" value="variables">
                                {threadId ? (
                                    <ThreadVariablesConfig threadId={threadId} />
                                ) : (
                                    <div className="text-brand-black/60 dark:text-brand-white/60 border-sidebar-border/50 bg-sidebar-accent/30 flex h-full items-center justify-center rounded-md border pr-2 pl-1 text-center">
                                        <p className="text-sm">{t`Start a conversation to configure variables.`}</p>
                                    </div>
                                )}
                            </TabsContent>
                        </Activity>
                        {isTextModel && (
                            <Activity mode={activeRightSidebarTab === "pins" ? "visible" : "hidden"}>
                                <TabsContent className="absolute inset-0 overflow-y-auto" value="pins">
                                    <PinsSidebarTab threadId={threadId} />
                                </TabsContent>
                            </Activity>
                        )}
                    </div>
                </Tabs>
            </SidebarContent>
            <SidebarRail name="right" side="right" />
        </Sidebar>
    );
};

export default ThreadSidebar;
