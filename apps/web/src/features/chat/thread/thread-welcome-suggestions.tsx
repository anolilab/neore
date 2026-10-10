"use client";

/**
 * ThreadWelcomeSuggestions v2 - Welcome suggestions for empty threads
 *
 * No assistant-ui dependencies - uses Zustand store for composer text.
 */

import { useLingui } from "@lingui/react/macro";
import { Tabs, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import cn from "@neore/ui/utils/cn";
import clsx from "clsx";
import { BookOpen, CheckCircle2, FileText, Lightbulb, Search, Video } from "lucide-react";
import type { FC } from "react";
import { useRef, useState } from "react";
import { useOutsideClick } from "rooks";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

const ThreadWelcomeSuggestions: FC<{ className?: string }> = ({ className }) => {
    const { t } = useLingui();
    const setComposerText = useChatUIStore((state) => state.setComposerText);
    const [activeTab, setActiveTab] = useState<string>("");
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const handleSuggestionClick = (prompt: string) => {
        setComposerText(prompt);
        setIsOpen(false);
        setActiveTab("");
    };

    const handleTabChange = (value: string) => {
        if (activeTab === value && isOpen) {
            setIsOpen(false);
            setActiveTab("");
        } else {
            setActiveTab(value);
            setIsOpen(true);
        }
    };

    const handleClickOutside = () => {
        if (!isOpen) {
            return;
        }

        setActiveTab("");
        setIsOpen(false);
    };

    // Close on click outside
    useOutsideClick(containerRef, handleClickOutside);

    const categories = {
        "fact-check": {
            icon: CheckCircle2,
            label: t`Fact Check`,
            suggestions: [
                t`Is it true that drinking 8 glasses of water daily is necessary?`,
                t`Verify the claim: "The Great Wall of China is visible from space"`,
                t`What's the scientific evidence for the health benefits of meditation?`,
                t`Fact check: Does sugar cause hyperactivity in children?`,
                t`Is the claim about 5G causing health issues supported by science?`,
            ],
        },
        ideas: {
            icon: Lightbulb,
            label: t`Ideas`,
            suggestions: [
                t`Brainstorm creative marketing strategies for a new product`,
                t`Generate unique business ideas for 2025`,
                t`Suggest innovative solutions to reduce plastic waste`,
                t`What are some creative date night ideas?`,
                t`Brainstorm ways to improve team productivity`,
            ],
        },
        research: {
            icon: BookOpen,
            label: t`Research`,
            suggestions: [
                t`What are the latest developments in quantum computing?`,
                t`Explain the causes and effects of climate change`,
                t`Compare the pros and cons of renewable energy sources`,
                t`What are the key findings from recent AI research papers?`,
                t`Summarize the history of the internet`,
            ],
        },
        search: {
            icon: Search,
            label: t`Search`,
            suggestions: [
                t`Find the best restaurants near me for Italian cuisine`,
                t`What are the top-rated productivity apps in 2025?`,
                t`Search for the latest news about space exploration`,
                t`Find tutorials on how to learn Python programming`,
                t`What are the current trends in web development?`,
            ],
        },
        videos: {
            icon: Video,
            label: t`Videos`,
            suggestions: [
                t`Create a script for a 5-minute educational video about photosynthesis`,
                t`Suggest video ideas for a tech YouTube channel`,
                t`Write a video description for a product launch`,
                t`What are the best practices for video editing?`,
                t`Generate a storyboard for a short documentary`,
            ],
        },
        writing: {
            icon: FileText,
            label: t`Writing`,
            suggestions: [
                t`Help me write a professional email to my manager`,
                t`Create an outline for a blog post about sustainable living`,
                t`Write a compelling product description for an e-commerce site`,
                t`Draft a cover letter for a software engineering position`,
                t`Generate ideas for a creative writing story`,
            ],
        },
    };

    const buildSuggestionHandlers = () => {
        const handlers: Record<string, () => void> = {};

        for (const [categoryKey, category] of Object.entries(categories)) {
            for (const suggestion of category.suggestions) {
                const key = `${categoryKey}-${suggestion}`;

                handlers[key] = () => {
                    handleSuggestionClick(suggestion);
                };
            }
        }

        return handlers;
    };

    const suggestionHandlers = buildSuggestionHandlers();

    return (
        <div className={cn("flex w-full flex-col overflow-hidden rounded-lg pt-2 pl-1.5", "bg-sidebar", className)} ref={containerRef}>
            <Tabs
                className={clsx("flex flex-col", {
                    "h-50": isOpen,
                })}
                onValueChange={handleTabChange}
                value={activeTab}
            >
                {isOpen && activeTab !== "" && (
                    <div className="flex-1 overflow-y-auto">
                        {Object.entries(categories).map(([key, category]) => {
                            if (key !== activeTab) {
                                return undefined;
                            }

                            const Icon = category.icon;

                            return (
                                <div className="flex flex-col" key={key}>
                                    {category.suggestions.map((suggestion) => {
                                        const suggestionKey = `${key}-${suggestion}`;

                                        return (
                                            <button
                                                className={cn(
                                                    "group relative flex min-h-[44px] cursor-pointer items-center gap-3 px-4 py-3 text-left text-sm transition-colors outline-none",
                                                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2",
                                                    "active:bg-muted",
                                                    "border-sidebar border-b last:border-b-0",
                                                    "bg-sidebar-foreground hover:bg-sidebar focus-visible:bg-sidebar active:bg-sidebar",
                                                )}
                                                key={suggestionKey}
                                                onClick={suggestionHandlers[suggestionKey]}
                                                type="button"
                                            >
                                                <Icon className="text-muted-foreground group-hover:text-foreground dark:text-muted-foreground dark:group-hover:text-foreground size-4 shrink-0 transition-colors" />
                                                <span className="text-foreground group-hover:text-foreground flex-1 leading-relaxed transition-colors dark:text-neutral-100 dark:group-hover:text-white">
                                                    {suggestion}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                )}

                <TabsList className="h-auto w-full justify-start rounded-none bg-transparent px-0 py-2 dark:bg-transparent" variant="line">
                    {Object.entries(categories).map(([key, category]) => {
                        const Icon = category.icon;

                        return (
                            <TabsTrigger
                                className="hover:text-foreground dark:hover:text-muted-foreground dark:data-active:text-muted-foreground flex items-center gap-1.5 px-3 py-2 text-sm after:bg-transparent dark:text-white dark:after:bg-transparent"
                                key={key}
                                value={key}
                            >
                                <Icon className="size-3.5" />
                                <span>{category.label}</span>
                            </TabsTrigger>
                        );
                    })}
                </TabsList>
            </Tabs>
        </div>
    );
};

export default ThreadWelcomeSuggestions;
