/**
 * SlashCommandPopup - Suggestion popup for slash commands in the tiptap composer
 *
 * Shows command, model, prompt, and skill suggestions when the user types `/`.
 * Reuses the existing Command UI components for a consistent look.
 */
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { api } from "@neore/backend/api";
import type { Doc } from "@neore/backend/dataModel";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import { Command, CommandEmpty, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "@neore/ui/components/command";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { CheckIcon, FileText, Star, Zap } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useModelPickerPopupActions } from "@/components/model-picker/model-picker-popup-store";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { useLunoraActionOptions } from "@/lib/lunora/crpc";

import type { SlashCommandMatch } from "./extensions/slash-command";

("use client");

// ============================================================================
// Types
// ============================================================================

type MenuType = "commands" | "models" | "prompts" | "skills" | undefined;

interface SlashCommandPopupProps {
    /** Rect of the editor element for positioning */
    editorRect: DOMRect | null;
    favoriteModelIds: string[];
    match: SlashCommandMatch | null;
    models: GatewayModel[];
    /** Called to dismiss the popup (e.g., after selecting a model) */
    onDismiss: () => void;
    /** Called to replace the slash text range in the editor */
    onReplace: (from: number, to: number, replacement: string) => void;
}

const COMMANDS = [
    { description: msg`Switch AI model`, id: "model", label: "model" },
    { description: msg`Insert a saved prompt`, id: "prompt", label: "prompt" },
    { description: msg`Invoke a skill`, id: "skill", label: "skill" },
] as const;

const MENU_WIDTH = 300;

// ============================================================================
// Filter helpers
// ============================================================================

const filterModels = (models: GatewayModel[], query: string, favoriteModelIds: string[], isProUser: boolean): GatewayModel[] => {
    let filtered = isProUser ? models : models.filter((m) => !m.isPremium);

    if (query) {
        const lowerQuery = query.toLowerCase();

        filtered = filtered.filter(
            (m) =>
                (m.name?.toLowerCase() ?? "").includes(lowerQuery) || m.id.toLowerCase().includes(lowerQuery) || m.provider?.toLowerCase().includes(lowerQuery),
        );
    }

    filtered.sort((a, b) => {
        const aFav = favoriteModelIds.includes(a.id);
        const bFav = favoriteModelIds.includes(b.id);

        if (aFav !== bFav) {
            return aFav ? -1 : 1;
        }

        return (a.name ?? "").localeCompare(b.name ?? "");
    });

    return filtered.slice(0, 10);
};

const filterPrompts = (prompts: Doc<"prompts">[], query: string): Doc<"prompts">[] => {
    if (!query) {
        return prompts.slice(0, 10);
    }

    const lowerQuery = query.toLowerCase();

    return prompts
        .filter(
            (p) =>
                p.name.toLowerCase().includes(lowerQuery) ||
                p.content.toLowerCase().includes(lowerQuery) ||
                p.description?.toLowerCase().includes(lowerQuery) ||
                p.tags?.some((tag: string) => tag.toLowerCase().includes(lowerQuery)),
        )
        .slice(0, 10);
};

const filterSkills = (skills: Doc<"skills">[], query: string): Doc<"skills">[] => {
    if (!query) {
        return skills.slice(0, 10);
    }

    const lowerQuery = query.toLowerCase();

    return skills
        .filter(
            (s) =>
                s.name.toLowerCase().includes(lowerQuery) ||
                s.slug.toLowerCase().includes(lowerQuery) ||
                s.description.toLowerCase().includes(lowerQuery) ||
                s.category?.toLowerCase().includes(lowerQuery),
        )
        .slice(0, 10);
};

// ============================================================================
// Main Component
// ============================================================================

const SlashCommandPopup: FC<SlashCommandPopupProps> = ({ editorRect, favoriteModelIds, match, models, onDismiss, onReplace }) => {
    const { i18n } = useLingui();
    const selectedModel = useModelStore((state) => state.selectedModel);
    const setSelectedModelStore = useModelStore((state) => state.setSelectedModel);
    const { open: openModelPickerPopup } = useModelPickerPopupActions();

    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const user = sessionData?.user;
    const isProUser = (user as { plan?: string; role?: string } | undefined)?.plan === "premium" || user?.role === "admin";

    // Fetch prompts and skills
    const { mutateAsync: getPrompts } = useMutation(useLunoraActionOptions(api.prompts.functions.getPrompts));
    const { mutateAsync: getSkills } = useMutation(useLunoraActionOptions(api.skills.functions.getSkills));
    const [prompts, setPrompts] = useState<Doc<"prompts">[]>([]);
    const [skills, setSkills] = useState<Doc<"skills">[]>([]);

    // Loaded once, on the first "/" — not on mount: the editor mounts this popup
    // permanently, and two actions on every first paint of /chat queued on the
    // one `__root__` shard (see `e2e/first-paint.e2e.test.ts`).
    const hasMatch = match !== null;
    const [shouldLoad, setShouldLoad] = useState(false);

    if (hasMatch && !shouldLoad) {
        setShouldLoad(true);
    }

    useEffect(() => {
        if (!shouldLoad) {
            return undefined;
        }

        let isCancelled = false;

        Promise.all([getPrompts({}), getSkills({ sortBy: "recent" })])
            .then(([p, s]) => {
                if (isCancelled) {
                    return undefined;
                }

                setPrompts(p as Doc<"prompts">[]);
                setSkills(s as Doc<"skills">[]);

                return undefined;
            })
            .catch(() => {});

        return () => {
            isCancelled = true;
        };
    }, [getPrompts, getSkills, shouldLoad]);

    const [selectedIndex, setSelectedIndex] = useState(0);
    const commandListRef = useRef<HTMLDivElement | null>(null);

    // Determine menu type and items
    const { items, type } = useMemo((): { items: ReadonlyArray<unknown>; type: MenuType } => {
        if (!match) return { items: [], type: undefined };

        if (match.command === undefined) {
            return { items: COMMANDS, type: "commands" };
        }

        if (match.command === "model") {
            return { items: filterModels(models, match.query, favoriteModelIds, isProUser), type: "models" };
        }

        if (match.command === "prompt") {
            return { items: filterPrompts(prompts, match.query), type: "prompts" };
        }

        if (match.command === "skill") {
            return { items: filterSkills(skills, match.query), type: "skills" };
        }

        return { items: [], type: undefined };
    }, [match, models, favoriteModelIds, isProUser, prompts, skills]);

    const itemCount = items.length;
    const isOpen = match !== null && itemCount > 0;

    // Reset the highlight when the item list changes. Adjusted during render
    // rather than through an effect so the popup never paints one frame with a
    // selection that belongs to the previous menu.
    const itemsKey = `${type ?? ""}:${itemCount}`;
    const [previousItemsKey, setPreviousItemsKey] = useState(itemsKey);

    if (previousItemsKey !== itemsKey) {
        setPreviousItemsKey(itemsKey);
        setSelectedIndex(0);
    }

    // Helpers
    const setSelectedModel = useCallback(
        (modelId: string) => {
            const currentThreadId = useModelStore.getState().selectedModelThreadId;

            setSelectedModelStore(modelId, currentThreadId);
        },
        [setSelectedModelStore],
    );

    // Selection handlers
    const handleSelectCommand = useCallback(
        (commandId: string) => {
            if (!match) {
                return;
            }

            if (commandId === "model") {
                openModelPickerPopup({
                    initialModelId: selectedModel,
                    onSelect: (modelId) => {
                        setSelectedModel(modelId);
                        onReplace(match.from, match.to, "");
                        onDismiss();
                    },
                });
                onReplace(match.from, match.to, "");
            } else {
                // Switch to sub-command mode (e.g., /prompt )
                onReplace(match.from, match.to, `/${commandId} `);
            }
        },
        [match, onReplace, onDismiss, openModelPickerPopup, selectedModel, setSelectedModel],
    );

    const handleSelectModel = useCallback(
        (model: GatewayModel) => {
            if (!match) {
                return;
            }

            if (model.isPremium && !isProUser) {
                return;
            }

            setSelectedModel(model.id);
            onReplace(match.from, match.to, "");
            onDismiss();
        },
        [match, isProUser, setSelectedModel, onReplace, onDismiss],
    );

    const handleSelectPrompt = useCallback(
        (prompt: Doc<"prompts">) => {
            if (!match) {
                return;
            }

            onReplace(match.from, match.to, prompt.content);
            onDismiss();
        },
        [match, onReplace, onDismiss],
    );

    const handleSelectSkill = useCallback(
        (skill: Doc<"skills">) => {
            if (!match) {
                return;
            }

            onReplace(match.from, match.to, `/${skill.slug} `);
            onDismiss();
        },
        [match, onReplace, onDismiss],
    );

    // Effect Events: the keydown listener is attached once per open/close and
    // per item count, instead of being torn down on every parent redraw that
    // rebuilds one of the selection handlers.
    const onCommitSelection = useEffectEvent(() => {
        const selected = items[selectedIndex];

        if (!selected) {
            return;
        }

        switch (type) {
            case "commands": {
                handleSelectCommand((selected as { id: string }).id);
                break;
            }
            case "models": {
                handleSelectModel(selected as GatewayModel);
                break;
            }
            case "prompts": {
                handleSelectPrompt(selected as Doc<"prompts">);
                break;
            }
            case "skills": {
                handleSelectSkill(selected as Doc<"skills">);
                break;
            }
            default: {
                break;
            }
        }
    });

    const onEscape = useEffectEvent(() => {
        onDismiss();
    });

    // Keyboard navigation
    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                event.stopPropagation();
                setSelectedIndex((previous) => (previous + 1) % itemCount);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                event.stopPropagation();
                setSelectedIndex((previous) => (previous - 1 + itemCount) % itemCount);
            } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                onCommitSelection();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onEscape();
            }
        };

        globalThis.addEventListener("keydown", handleKeyDown, { capture: true });

        return () => globalThis.removeEventListener("keydown", handleKeyDown, true);
    }, [isOpen, itemCount]);

    if (!isOpen || !editorRect) {
        return null;
    }

    // Position above the editor
    const position = {
        left: editorRect.left,
        top: editorRect.top,
    };

    const selectedValue = (() => {
        const selected = items[selectedIndex];

        if (!selected) {
            return undefined;
        }

        if (type === "commands") return (selected as { id: string }).id;

        if (type === "models") {
            return (selected as GatewayModel).id;
        }

        if (type === "prompts") {
            return (selected as Doc<"prompts">)._id;
        }

        if (type === "skills") {
            return (selected as Doc<"skills">)._id;
        }

        return undefined;
    })();

    return createPortal(
        <div
            className="fixed z-50"
            style={{
                left: `${position.left}px`,
                top: `${position.top}px`,
                transform: "translateY(-100%)",
            }}
        >
            <div
                className={clsx(
                    "overflow-hidden rounded-lg border",
                    "bg-popover text-popover-foreground",
                    "dark:bg-[oklch(0.205_0_0)] dark:text-[oklch(0.985_0_0)]",
                    "border-border dark:border-white/10",
                    "shadow-md dark:shadow-xl dark:shadow-black/50",
                    "ring-foreground/10 ring-1 dark:ring-white/10",
                    "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                )}
                style={{ width: MENU_WIDTH }}
            >
                <Command onValueChange={() => {}} value={selectedValue}>
                    <div className="outline-none" ref={commandListRef} tabIndex={-1}>
                        <CommandList className="max-h-[300px]">
                            {type === "commands" && (
                                <CommandGroup>
                                    <CommandGroupLabel>
                                        <Trans>Commands</Trans>
                                    </CommandGroupLabel>
                                    {(items as ReadonlyArray<(typeof COMMANDS)[number]>).map((command, index) => (
                                        <CommandItem
                                            className={clsx("transition-colors", index === selectedIndex && "bg-accent text-accent-foreground")}
                                            key={command.id}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                handleSelectCommand(command.id);
                                            }}
                                            value={command.id}
                                        >
                                            <span className="font-medium">/{command.id}</span>
                                            <span className="text-muted-foreground ml-2 text-xs">{i18n._(command.description)}</span>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}
                            {type === "models" && (
                                <CommandGroup>
                                    <CommandGroupLabel>
                                        <Trans>Switch Model</Trans>
                                    </CommandGroupLabel>
                                    {(items as GatewayModel[]).map((model, index) => {
                                        const isSelected = selectedModel === model.id;
                                        const isSelectable = !model.isPremium || isProUser;

                                        return (
                                            <CommandItem
                                                className={clsx(
                                                    "transition-colors",
                                                    index === selectedIndex && "bg-accent text-accent-foreground",
                                                    !isSelectable && "cursor-not-allowed opacity-50",
                                                )}
                                                disabled={!isSelectable}
                                                key={model.id}
                                                onClick={(e) => {
                                                    e.preventDefault();

                                                    if (isSelectable) {
                                                        handleSelectModel(model);
                                                    }
                                                }}
                                                value={model.id}
                                            >
                                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                                    {model.displayProvider && (
                                                        <ProviderIcon
                                                            className="size-3"
                                                            provider={model.provider || model.displayProvider}
                                                            providerIcon={model.displayProvider}
                                                        />
                                                    )}
                                                    <span className="flex-1 truncate text-left font-medium">{model.name ?? model.id}</span>
                                                </div>
                                                {isSelected && <CheckIcon className="text-primary ml-auto size-4" />}
                                            </CommandItem>
                                        );
                                    })}
                                </CommandGroup>
                            )}
                            {type === "prompts" && (
                                <CommandGroup>
                                    <CommandGroupLabel>
                                        <Trans>Insert Prompt</Trans>
                                    </CommandGroupLabel>
                                    {(items as Doc<"prompts">[]).map((prompt, index) => (
                                        <CommandItem
                                            className={clsx("transition-colors", index === selectedIndex && "bg-accent text-accent-foreground")}
                                            key={prompt._id}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                handleSelectPrompt(prompt);
                                            }}
                                            value={prompt._id}
                                        >
                                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                                {prompt.isFavorite ? (
                                                    <Star className="size-4 shrink-0 fill-current text-yellow-500" />
                                                ) : (
                                                    <FileText className="text-muted-foreground size-4 shrink-0" />
                                                )}
                                                <div className="min-w-0 flex-1">
                                                    <span className="block truncate font-medium">{prompt.name}</span>
                                                    <span className="text-muted-foreground block truncate text-xs">
                                                        {prompt.content.slice(0, 50)}
                                                        {prompt.content.length > 50 ? "..." : ""}
                                                    </span>
                                                </div>
                                            </div>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}
                            {type === "skills" && (
                                <CommandGroup>
                                    <CommandGroupLabel>
                                        <Trans>Invoke Skill</Trans>
                                    </CommandGroupLabel>
                                    {(items as Doc<"skills">[]).map((skill, index) => (
                                        <CommandItem
                                            className={clsx("transition-colors", index === selectedIndex && "bg-accent text-accent-foreground")}
                                            key={skill._id}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                handleSelectSkill(skill);
                                            }}
                                            value={skill._id}
                                        >
                                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                                <Zap className="text-primary size-4 shrink-0" />
                                                <div className="min-w-0 flex-1">
                                                    <span className="block truncate font-medium">{skill.name}</span>
                                                    <span className="text-muted-foreground block truncate text-xs">
                                                        /{skill.slug} - {skill.description.slice(0, 40)}
                                                        {skill.description.length > 40 ? "..." : ""}
                                                    </span>
                                                </div>
                                            </div>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}
                            {items.length === 0 && (
                                <CommandEmpty>
                                    <Trans>No results found</Trans>
                                </CommandEmpty>
                            )}
                        </CommandList>
                    </div>
                </Command>
            </div>
        </div>,
        document.body,
    );
};

export default SlashCommandPopup;
