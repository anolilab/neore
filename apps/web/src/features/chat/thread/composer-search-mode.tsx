"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import clsx from "clsx";
import { Bitcoin, Check, Code, Globe, GraduationCap, MessageCircle, MessageSquare, Music, TrendingUp } from "lucide-react";
import type { ComponentType, FC } from "react";

import { Github, Twitter, Youtube } from "@/components/brand-icons";
import type { SearchMode } from "@/features/chat/core/stores/model-store";

/**
 * Lucide icons and the local brand SVGs (plain function components, since lucide v1
 * dropped brand icons) have different component types; only the props actually used
 * here are part of the contract.
 */
type SearchModeIcon = ComponentType<{ className?: string; size?: number | string }>;

interface SearchModeInfo {
    description: string;
    enabled: boolean;
    icon: SearchModeIcon;
    id: SearchMode;
    label: string;
}

interface ComposerSearchModeProps {
    disabled?: boolean;
    mode: SearchMode;
    onModeChange: (mode: SearchMode) => void;
}

const ComposerSearchMode: FC<ComposerSearchModeProps> = ({ disabled, mode, onModeChange }) => {
    const { t } = useLingui();
    /*
     * This used to gate every mode but "chat" behind
     * `user.plan === "premium"`. The session user has no `plan` field and this
     * app has no plan tier at all — billing is credit-based — so the check was
     * always false: every user, paying or not, saw twelve working search modes
     * locked behind an upsell for a subscription that is not sold. Removed
     * rather than left as a paywall that can never open. Re-add it here if a
     * real entitlement source ever lands.
     */

    const modes: SearchModeInfo[] = [
        { description: t`Talk to the model directly`, enabled: true, icon: MessageSquare, id: "chat", label: t`Chat` },
        { description: t`Search across the entire internet`, enabled: true, icon: Globe, id: "web", label: t`Web` },
        { description: t`Search academic papers and PDFs`, enabled: true, icon: GraduationCap, id: "academic", label: t`Academic` },
        { description: t`Search X posts`, enabled: true, icon: Twitter, id: "x", label: t`X` },
        { description: t`Search Reddit posts`, enabled: true, icon: MessageCircle, id: "reddit", label: t`Reddit` },
        { description: t`Search YouTube videos and channels`, enabled: true, icon: Youtube, id: "youtube", label: t`YouTube` },
        { description: t`Stock and currency information`, enabled: true, icon: TrendingUp, id: "stocks", label: t`Stocks` },
        { description: t`Cryptocurrency research`, enabled: true, icon: Bitcoin, id: "crypto", label: t`Crypto` },
        { description: t`Search Stack Overflow for programming help`, enabled: true, icon: Code, id: "code", label: t`Code` },
        { description: t`Search GitHub repositories and code`, enabled: true, icon: Github, id: "github", label: t`GitHub` },
        { description: t`Search songs, artists, and albums`, enabled: true, icon: Music, id: "spotify", label: t`Spotify` },
    ];

    const enabledModes = modes.filter((m) => m.enabled);
    // modes is a non-empty array, so modes[0] is always defined
    const currentMode = (modes.find((m) => m.id === mode) ?? modes[0]) as SearchModeInfo;
    const CurrentIcon = currentMode.icon;

    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <DropdownMenuTrigger
                            disabled={disabled}
                            render={
                                <Button
                                    className={clsx(
                                        "bg-sidebar border-border dark:border-sidebar-border/15 hover:bg-accent/50 dark:hover:bg-sidebar-accent/30 hover:border-border dark:hover:border-sidebar-border/50 text-foreground h-7 gap-1 px-2 dark:text-white",
                                        mode !== "chat" &&
                                            "bg-primary/10 text-primary border-primary/30 dark:text-primary hover:bg-primary/20 hover:border-primary/40",
                                    )}
                                    variant="outline"
                                >
                                    <CurrentIcon className="size-3 shrink-0" />
                                    <span className="hidden md:inline">{currentMode.label}</span>
                                </Button>
                            }
                        />
                    }
                />
                <TooltipContent side="top" sideOffset={8}>
                    <p>{t`Search mode: ${currentMode.label}`}</p>
                </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="max-h-[400px] min-w-[240px] overflow-y-auto" sideOffset={6}>
                <div className="text-muted-foreground px-2 py-1.5 text-xs font-semibold">{t`Choose Search Mode`}</div>
                {enabledModes.map(({ description, icon: Icon, id, label }) => (
                    <DropdownMenuItem className="flex flex-row gap-2.5 py-2.5" key={id} onClick={() => onModeChange(id)}>
                        <Icon className="mt-0.5 size-5 shrink-0" />
                        <div className="flex grow flex-col items-start gap-0.5">
                            <span className="font-medium">{label}</span>
                            <span className="text-muted-foreground text-xs">{description}</span>
                        </div>
                        {mode === id && <Check className="text-primary size-4 shrink-0" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default ComposerSearchMode;
