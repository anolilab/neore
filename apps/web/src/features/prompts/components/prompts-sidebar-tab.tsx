"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Doc, Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Braces, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Edit, MoreVertical, Plus, Search, Star, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import useCheckout from "@/features/billing/hooks/use-checkout";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";

import validatePromptSettings from "../lib/prompt-validation";
import { extractVariables, getAutoPopulatedVariables, replaceVariables } from "../lib/prompt-variables";
import PromptFormDialog from "./prompt-form-dialog";
import VariableFillDialog from "./variable-fill-dialog";

interface PromptsSidebarTabProps {
    threadId?: string;
}

const PromptsSidebarTab = ({ threadId }: PromptsSidebarTabProps) => {
    const { t } = useLingui();
    const { upgradeToast } = useCheckout();
    const crpc = useCRPC();
    const models = useFeatureFlaggedModels();
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<Doc<"prompts"> | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [fillDialogPrompt, setFillDialogPrompt] = useState<Doc<"prompts"> | null>(null);
    const [collapsedGroups, setCollapsedGroups] = useState<Set<"favorites" | "all">>(() => new Set());
    const [searchQuery, setSearchQuery] = useState("");
    const [currentPage, setCurrentPage] = useState(1);
    const [promptToDelete, setPromptToDelete] = useState<Doc<"prompts"> | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const ITEMS_PER_PAGE = 10;

    // Get the Zustand store function for setting composer text
    const setComposerText = useChatUIStore((state) => state.setComposerText);

    // Get current user context for auto-populated variables
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const { data: activeOrganization } = hooks.useActiveOrganization();

    // Model store for applying settings
    const setSelectedModel = useModelStore((state) => state.setSelectedModel);
    const setPendingSettings = useModelStore((state) => state.setPendingSettings);

    const isLoggedIn = !!sessionData?.user;

    // Fetch prompts using action (with caching)
    const { mutateAsync: getPrompts } = useMutation(useLunoraActionOptions(api.prompts.functions.getPrompts));
    const [prompts, setPrompts] = useState<Doc<"prompts">[] | undefined>(undefined);

    // Fetch prompt count using action (with caching)
    const { mutateAsync: getPromptCount } = useMutation(useLunoraActionOptions(api.prompts.functions.getPromptCount));
    const [promptCount, setPromptCount] = useState<{ canCreate: boolean; count: number; isPremium: boolean; limit: number | null } | undefined>(undefined);

    // Load prompts and prompt count on mount
    useEffect(() => {
        let isCancelled = false;

        Promise.all([getPrompts({}), getPromptCount({})])
            .then(([promptsResult, count]) => {
                if (isCancelled) {
                    return undefined;
                }

                setPrompts(promptsResult as Doc<"prompts">[]);
                setPromptCount(count);

                return undefined;
            })
            .catch(() => {
                // Ignore errors
            });

        return () => {
            isCancelled = true;
        };
    }, [getPrompts, getPromptCount]);

    // Query resolved variables (includes user defaults + thread overrides).
    // `threadId` is the `/chat/$threadId` route param, passed down as a plain string.
    const { data: resolvedVariables } = useQuery(crpc.prompts.functions.getResolvedVariables.queryOptions({ threadId: threadId as Id<"threads"> | undefined }));

    // Build a map of variable values including auto-populated ones
    const variableValues = useMemo(() => {
        // Get auto-populated variables (lowest priority)
        const autoVariables = getAutoPopulatedVariables({
            email: sessionData?.user?.email,
            name: sessionData?.user?.name,
            organization: activeOrganization?.name,
        });

        // Merge with resolved vars (user defaults + thread overrides have higher priority)
        return {
            ...autoVariables,
            ...resolvedVariables?.values,
        };
    }, [resolvedVariables, sessionData, activeOrganization]);

    // Mutations
    const { mutateAsync: createPrompt } = useMutation(crpc.prompts.functions.createPrompt.mutationOptions());
    const { mutateAsync: updatePrompt } = useMutation(crpc.prompts.functions.updatePrompt.mutationOptions());
    const { mutateAsync: deletePrompt } = useMutation(crpc.prompts.functions.deletePrompt.mutationOptions());
    const { mutateAsync: toggleFavorite } = useMutation(crpc.prompts.functions.togglePromptFavorite.mutationOptions());
    const { mutate: recordUsage } = useMutation(crpc.prompts.functions.recordPromptUsage.mutationOptions());

    const handleCopy = useCallback(
        async (prompt: Doc<"prompts">) => {
            try {
                await navigator.clipboard.writeText(prompt.content);
                setCopiedId(prompt._id);
                toast.success(t`Copied to clipboard`);
                setTimeout(setCopiedId, 2000, null);
            } catch {
                toast.error(t`Failed to copy`);
            }
        },
        [t],
    );

    // Check if prompt has missing variables
    const getMissingVariables = useCallback(
        (prompt: Doc<"prompts">) => {
            const variableNames = extractVariables(prompt.content);
            const definitionMap = new Map<string, { defaultValue?: string; name: string }>(
                (prompt.variables || []).map((v: { defaultValue?: string; name: string }) => [v.name, v] as [string, { defaultValue?: string; name: string }]),
            );

            return variableNames.filter((name) => {
                const hasExisting = variableValues[name]?.trim();
                const hasDefault = definitionMap.get(name)?.defaultValue?.trim();

                return !hasExisting && !hasDefault;
            });
        },
        [variableValues],
    );

    const handleUse = useCallback(
        (prompt: Doc<"prompts">) => {
            // Validate prompt settings before using
            const validationResult = validatePromptSettings(prompt.model ?? undefined, prompt.reasoningEffort ?? undefined, prompt.enabledFeatures, models);

            if (!validationResult.isValid) {
                const errorMessages = Object.values(validationResult.errors).filter(Boolean).flat().join(", ");

                toast.error(t`Cannot use prompt: ${errorMessages}`);

                return;
            }

            // Apply model settings if configured
            if (prompt.model) {
                // Get current thread ID if available
                const currentThreadId = threadId || undefined;

                setSelectedModel(prompt.model, currentThreadId);
            }

            // Apply reasoning effort and features via pendingSettings (for new threads) or thread update
            if (prompt.reasoningEffort !== undefined || prompt.enabledFeatures) {
                setPendingSettings({
                    enabledFeatures: prompt.enabledFeatures,
                    reasoningEffort: prompt.reasoningEffort ?? undefined,
                });
            }

            // Check for missing variables
            const missing = getMissingVariables(prompt);

            if (missing.length > 0) {
                // Show fill dialog
                setFillDialogPrompt(prompt);

                return;
            }

            // No missing variables, use directly
            let { content } = prompt;

            // Build complete values map: thread variables + prompt defaults
            const values = { ...variableValues };

            if (prompt.variables) {
                for (const v of prompt.variables) {
                    if (!Object.hasOwn(values, v.name) && v.defaultValue) {
                        values[v.name] = v.defaultValue;
                    }
                }
            }

            // Replace variables
            content = replaceVariables(content, values, { keepUnmatched: true });

            // Use Zustand store to set the composer text
            setComposerText(content);
            toast.success(t`Prompt added to input`);
            // Record usage
            recordUsage({ promptId: prompt._id });
        },
        [setComposerText, t, variableValues, getMissingVariables, models, recordUsage, threadId, setSelectedModel, setPendingSettings],
    );

    const handleFillDialogUse = useCallback(
        (content: string, _newValues: Record<string, string>) => {
            // Use the content with filled variables
            // Note: newValues could be saved to thread variables in the future
            setComposerText(content);
            toast.success(t`Prompt added to input`);

            // Record usage
            if (fillDialogPrompt) {
                recordUsage({ promptId: fillDialogPrompt._id });
            }

            setFillDialogPrompt(null);
        },
        [setComposerText, t, fillDialogPrompt, recordUsage],
    );

    const handleFillDialogUseAnyway = useCallback(
        (content: string) => {
            setComposerText(content);
            toast.success(t`Prompt added with placeholders`);

            // Record usage
            if (fillDialogPrompt) {
                recordUsage({ promptId: fillDialogPrompt._id });
            }

            setFillDialogPrompt(null);
        },
        [setComposerText, t, fillDialogPrompt, recordUsage],
    );

    const handleFillDialogCancel = useCallback(() => {
        setFillDialogPrompt(null);
    }, []);

    const handleEdit = useCallback((prompt: Doc<"prompts">) => {
        setEditingPrompt(prompt);
        setIsDialogOpen(true);
    }, []);

    const handleDelete = useCallback(
        (promptId: Id<"prompts">) => {
            const prompt = prompts?.find((p) => p._id === promptId);

            if (prompt) {
                setPromptToDelete(prompt);
            }
        },
        [prompts],
    );

    const handleConfirmDelete = useCallback(async () => {
        if (!promptToDelete) {
            return;
        }

        setIsDeleting(true);

        try {
            await deletePrompt({ promptId: promptToDelete._id });
            toast.success(t`Prompt deleted`);
            setPromptToDelete(null);
        } catch {
            toast.error(t`Failed to delete prompt`);
        } finally {
            setIsDeleting(false);
        }
    }, [deletePrompt, promptToDelete, t]);

    const handleToggleFavorite = useCallback(
        async (promptId: Id<"prompts">) => {
            try {
                await toggleFavorite({ promptId });
            } catch {
                toast.error(t`Failed to update favorite status`);
            }
        },
        [toggleFavorite, t],
    );

    // Filter prompts based on search query
    const filteredPrompts = useMemo(() => {
        if (!prompts) {
            return [];
        }

        if (!searchQuery.trim()) {
            return prompts;
        }

        const query = searchQuery.toLowerCase();

        return prompts.filter(
            (prompt) =>
                prompt.name.toLowerCase().includes(query) ||
                prompt.content.toLowerCase().includes(query) ||
                prompt.description?.toLowerCase().includes(query) ||
                prompt.tags?.some((tag: string) => tag.toLowerCase().includes(query)) ||
                prompt.variables?.some((v: { name: string }) => v.name.toLowerCase().includes(query)),
        );
    }, [prompts, searchQuery]);

    // Group prompts: favorites and all prompts
    const promptGroups = useMemo(() => {
        const favorites: Doc<"prompts">[] = [];
        const all: Doc<"prompts">[] = [];

        filteredPrompts.forEach((prompt) => {
            if (prompt.isFavorite) {
                favorites.push(prompt);
            } else {
                all.push(prompt);
            }
        });

        // Sort each group alphabetically by name
        favorites.sort((a, b) => a.name.localeCompare(b.name));
        all.sort((a, b) => a.name.localeCompare(b.name));

        return { all, favorites };
    }, [filteredPrompts]);

    // Paginate groups - show all favorites, then paginate "all" group
    const paginatedGroups = useMemo(() => {
        // Always show all favorites
        const { favorites } = promptGroups;

        // Paginate "all" group separately
        const allStartIndex = (currentPage - 1) * ITEMS_PER_PAGE;
        const allEndIndex = allStartIndex + ITEMS_PER_PAGE;
        const paginatedAll = promptGroups.all.slice(allStartIndex, allEndIndex);

        // Calculate total pages based on "all" group (favorites are always shown)
        const totalItems = favorites.length + promptGroups.all.length;
        const totalPages = Math.ceil(promptGroups.all.length / ITEMS_PER_PAGE) || 1;

        return {
            all: paginatedAll,
            favorites,
            hasMoreAll: promptGroups.all.length > allEndIndex,
            totalItems,
            totalPages,
        };
    }, [promptGroups, currentPage]);

    // Reset to page 1 when search changes
    const handleSearchChange = useCallback((query: string) => {
        setSearchQuery(query);
        setCurrentPage(1);
    }, []);

    const toggleGroupCollapsed = useCallback((group: "favorites" | "all") => {
        setCollapsedGroups((previous) => {
            const next = new Set(previous);

            if (next.has(group)) {
                next.delete(group);
            } else {
                next.add(group);
            }

            return next;
        });
    }, []);

    const handleSubmit = useCallback(
        async (data: {
            content: string;
            description?: string;
            enabledFeatures?: string[];
            isFavorite?: boolean;
            model?: string;
            name: string;
            promptId?: Id<"prompts">;
            reasoningEffort?: number;
            tags?: string[];
            variables?: { defaultValue?: string; description?: string; name: string; required?: boolean }[];
        }) => {
            try {
                if (data.promptId) {
                    await updatePrompt({
                        content: data.content,
                        description: data.description,
                        enabledFeatures: data.enabledFeatures,
                        isFavorite: data.isFavorite,
                        model: data.model,
                        name: data.name,
                        promptId: data.promptId,
                        reasoningEffort: data.reasoningEffort,
                        tags: data.tags,
                        variables: data.variables,
                    });
                    toast.success(t`Prompt updated`);
                } else {
                    await createPrompt({
                        content: data.content,
                        description: data.description,
                        enabledFeatures: data.enabledFeatures,
                        isFavorite: data.isFavorite,
                        model: data.model,
                        name: data.name,
                        reasoningEffort: data.reasoningEffort,
                        tags: data.tags,
                        variables: data.variables,
                    });
                    toast.success(t`Prompt created`);
                }

                setEditingPrompt(null);
            } catch (error: any) {
                // Check for prompt limit error
                if (error?.data?.code === "PROMPT_LIMIT_REACHED" || error?.message?.includes("PROMPT_LIMIT_REACHED")) {
                    upgradeToast(t`Free accounts are limited to 3 prompts. Upgrade to Pro for unlimited prompts.`);
                } else {
                    toast.error(t`Failed to save prompt`);
                }

                throw new Error("Failed to save prompt", { cause: error });
            }
        },
        [createPrompt, updatePrompt, t, upgradeToast],
    );

    // Loading state
    if (prompts === undefined) {
        return (
            <div className="space-y-2 p-2">
                {Array.from({ length: 3 }, (_, i) => (
                    <div className="bg-muted h-16 animate-pulse rounded-lg" key={i} />
                ))}
            </div>
        );
    }

    return (
        <div className="pr-2 pl-1">
            <div className="flex h-full flex-col">
                <div className="flex items-center justify-between border-b p-2">
                    <div className="flex items-center gap-2">
                        <span className="text-foreground text-sm font-medium">{t`Prompts`}</span>
                        {promptCount && !promptCount.isPremium && (
                            <Badge className="text-xs" variant="secondary">
                                {promptCount.count}/{promptCount.limit}
                            </Badge>
                        )}
                    </div>
                    <Button
                        disabled={!isLoggedIn || (promptCount ? !promptCount.canCreate : false)}
                        onClick={() => {
                            if (!isLoggedIn) {
                                toast.error(t`Please log in to create prompts`);

                                return;
                            }

                            if (promptCount && !promptCount.canCreate) {
                                upgradeToast(t`Free accounts are limited to 3 prompts. Upgrade to Pro for unlimited prompts.`);

                                return;
                            }

                            setIsDialogOpen(true);
                        }}
                        size="icon-sm"
                        variant="ghost"
                    >
                        <Plus className="size-4" />
                    </Button>
                </div>

                {/* Search Bar */}
                {prompts && prompts.length > 0 && (
                    <div className="border-b p-2">
                        <div className="relative">
                            <Search className="text-muted-foreground absolute top-1/2 left-2 size-4 -translate-y-1/2" />
                            <Input
                                className="pr-8 pl-8"
                                onChange={(e) => handleSearchChange(e.target.value)}
                                placeholder={t`Search prompts...`}
                                value={searchQuery}
                            />
                            {searchQuery && (
                                <Button
                                    className="absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 p-0"
                                    onClick={() => handleSearchChange("")}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <X className="size-3" />
                                </Button>
                            )}
                        </div>
                    </div>
                )}

                <ScrollArea className="flex-1">
                    {prompts.length === 0 && (
                        <div className="flex flex-col items-center justify-center gap-2 p-4 text-center">
                            <p className="text-muted-foreground text-sm">{t`No prompts yet`}</p>
                            {!isLoggedIn && <p className="text-muted-foreground text-xs">{t`Please log in to create prompts`}</p>}
                            {isLoggedIn && promptCount && !promptCount.isPremium && (
                                <p className="text-muted-foreground text-xs">
                                    {promptCount.canCreate
                                        ? t`Free accounts can create up to 3 prompts. Upgrade to Pro for unlimited prompts.`
                                        : t`You've reached the free account limit of 3 prompts. Upgrade to Pro to create more.`}
                                </p>
                            )}
                            <Button
                                disabled={!isLoggedIn || (promptCount ? !promptCount.canCreate : false)}
                                onClick={() => {
                                    if (!isLoggedIn) {
                                        toast.error(t`Please log in to create prompts`);

                                        return;
                                    }

                                    if (promptCount && !promptCount.canCreate) {
                                        upgradeToast(t`Free accounts are limited to 3 prompts. Upgrade to Pro for unlimited prompts.`);

                                        return;
                                    }

                                    setIsDialogOpen(true);
                                }}
                                size="sm"
                                variant="outline"
                            >
                                <Plus className="mr-1 size-3" />
                                {t`Create`}
                            </Button>
                        </div>
                    )}
                    {prompts.length > 0 && filteredPrompts.length === 0 && (
                        <div className="flex flex-col items-center justify-center gap-2 p-4 text-center">
                            <p className="text-muted-foreground text-sm">{searchQuery ? t`No prompts found matching "${searchQuery}"` : t`No prompts yet`}</p>
                            {!isLoggedIn && !searchQuery && <p className="text-muted-foreground text-xs">{t`Please log in to create prompts`}</p>}
                        </div>
                    )}
                    {prompts.length > 0 && filteredPrompts.length > 0 && (
                        <div className="space-y-3 p-2">
                            {/* Favorites Group */}
                            {paginatedGroups.favorites.length > 0 && (
                                <div className="space-y-1">
                                    {/* Group Header */}
                                    <div
                                        className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-2 px-2 py-1 text-xs font-medium transition-colors"
                                        onClick={() => toggleGroupCollapsed("favorites")}
                                        onKeyDown={(e) => {
                                            if (!(e.key === "Enter" || e.key === " ")) {
                                                return;
                                            }

                                            e.preventDefault();
                                            toggleGroupCollapsed("favorites");
                                        }}
                                        role="button"
                                        tabIndex={0}
                                    >
                                        {collapsedGroups.has("favorites") ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                                        <span>{t`Favorites`}</span>
                                        <span className="text-muted-foreground/70">({promptGroups.favorites.length})</span>
                                    </div>

                                    {/* Favorites Prompts */}
                                    {!collapsedGroups.has("favorites") && (
                                        <div className="space-y-1">
                                            {paginatedGroups.favorites.map((prompt) => {
                                                const variables = extractVariables(prompt.content);
                                                const hasVariables = variables.length > 0;

                                                return (
                                                    <div
                                                        className="hover:bg-muted group flex cursor-pointer items-start gap-2 rounded-lg p-2 transition-colors"
                                                        key={prompt._id}
                                                        onClick={() => handleUse(prompt)}
                                                        onKeyDown={(e) => {
                                                            if (!(e.key === "Enter" || e.key === " ")) {
                                                                return;
                                                            }

                                                            e.preventDefault();
                                                            handleUse(prompt);
                                                        }}
                                                        role="button"
                                                        tabIndex={0}
                                                    >
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center gap-1">
                                                                <span className="text-foreground truncate text-sm font-medium">{prompt.name}</span>
                                                                {hasVariables && (
                                                                    <Badge className="ml-1 px-1 py-0" variant="outline">
                                                                        <Braces className="mr-0.5 size-2.5" />
                                                                        <span className="text-[10px]">{variables.length}</span>
                                                                    </Badge>
                                                                )}
                                                            </div>
                                                            <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                                                                {prompt.content.slice(0, 80)}
                                                                {prompt.content.length > 80 ? "..." : ""}
                                                            </p>
                                                        </div>
                                                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                                            <Tooltip>
                                                                <TooltipTrigger
                                                                    render={
                                                                        <Button
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                handleCopy(prompt);
                                                                            }}
                                                                            size="icon-xs"
                                                                            variant="ghost"
                                                                        >
                                                                            {copiedId === prompt._id ? (
                                                                                <Check className="size-3" />
                                                                            ) : (
                                                                                <Copy className="size-3" />
                                                                            )}
                                                                        </Button>
                                                                    }
                                                                />
                                                                <TooltipContent side="left">{t`Copy to clipboard`}</TooltipContent>
                                                            </Tooltip>
                                                            <DropdownMenu>
                                                                <DropdownMenuTrigger
                                                                    render={
                                                                        <Button onClick={(e) => e.stopPropagation()} size="icon-xs" variant="ghost">
                                                                            <MoreVertical className="size-3" />
                                                                        </Button>
                                                                    }
                                                                />
                                                                <DropdownMenuContent align="end">
                                                                    <DropdownMenuItem
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleEdit(prompt);
                                                                        }}
                                                                    >
                                                                        <Edit className="mr-2 size-3" />
                                                                        {t`Edit`}
                                                                    </DropdownMenuItem>
                                                                    <DropdownMenuItem
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleToggleFavorite(prompt._id);
                                                                        }}
                                                                    >
                                                                        <Star className="mr-2 size-3 fill-current" />
                                                                        {t`Remove from Favorites`}
                                                                    </DropdownMenuItem>
                                                                    <DropdownMenuSeparator />
                                                                    <DropdownMenuItem
                                                                        className="text-destructive"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleDelete(prompt._id);
                                                                        }}
                                                                        variant="destructive"
                                                                    >
                                                                        <Trash2 className="mr-2 size-3" />
                                                                        {t`Delete`}
                                                                    </DropdownMenuItem>
                                                                </DropdownMenuContent>
                                                            </DropdownMenu>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* All Prompts Group */}
                            {paginatedGroups.all.length > 0 && (
                                <div className="space-y-1">
                                    {/* Group Header */}
                                    <div
                                        className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-2 px-2 py-1 text-xs font-medium transition-colors"
                                        onClick={() => toggleGroupCollapsed("all")}
                                        onKeyDown={(e) => {
                                            if (!(e.key === "Enter" || e.key === " ")) {
                                                return;
                                            }

                                            e.preventDefault();
                                            toggleGroupCollapsed("all");
                                        }}
                                        role="button"
                                        tabIndex={0}
                                    >
                                        {collapsedGroups.has("all") ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                                        <span>{t`All Prompts`}</span>
                                        <span className="text-muted-foreground/70">({promptGroups.all.length})</span>
                                    </div>

                                    {/* All Prompts */}
                                    {!collapsedGroups.has("all") && (
                                        <div className="space-y-1">
                                            {paginatedGroups.all.map((prompt) => {
                                                const variables = extractVariables(prompt.content);
                                                const hasVariables = variables.length > 0;

                                                return (
                                                    <div
                                                        className="hover:bg-muted group flex cursor-pointer items-start gap-2 rounded-lg p-2 transition-colors"
                                                        key={prompt._id}
                                                        onClick={() => handleUse(prompt)}
                                                        onKeyDown={(e) => {
                                                            if (!(e.key === "Enter" || e.key === " ")) {
                                                                return;
                                                            }

                                                            e.preventDefault();
                                                            handleUse(prompt);
                                                        }}
                                                        role="button"
                                                        tabIndex={0}
                                                    >
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center gap-1">
                                                                <span className="text-foreground truncate text-sm font-medium">{prompt.name}</span>
                                                                {hasVariables && (
                                                                    <Badge className="ml-1 px-1 py-0" variant="outline">
                                                                        <Braces className="mr-0.5 size-2.5" />
                                                                        <span className="text-[10px]">{variables.length}</span>
                                                                    </Badge>
                                                                )}
                                                            </div>
                                                            <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                                                                {prompt.content.slice(0, 80)}
                                                                {prompt.content.length > 80 ? "..." : ""}
                                                            </p>
                                                        </div>
                                                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                                            <Tooltip>
                                                                <TooltipTrigger
                                                                    render={
                                                                        <Button
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                handleCopy(prompt);
                                                                            }}
                                                                            size="icon-xs"
                                                                            variant="ghost"
                                                                        >
                                                                            {copiedId === prompt._id ? (
                                                                                <Check className="size-3" />
                                                                            ) : (
                                                                                <Copy className="size-3" />
                                                                            )}
                                                                        </Button>
                                                                    }
                                                                />
                                                                <TooltipContent side="left">{t`Copy to clipboard`}</TooltipContent>
                                                            </Tooltip>
                                                            <DropdownMenu>
                                                                <DropdownMenuTrigger
                                                                    render={
                                                                        <Button onClick={(e) => e.stopPropagation()} size="icon-xs" variant="ghost">
                                                                            <MoreVertical className="size-3" />
                                                                        </Button>
                                                                    }
                                                                />
                                                                <DropdownMenuContent align="end">
                                                                    <DropdownMenuItem
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleEdit(prompt);
                                                                        }}
                                                                    >
                                                                        <Edit className="mr-2 size-3" />
                                                                        {t`Edit`}
                                                                    </DropdownMenuItem>
                                                                    <DropdownMenuItem
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleToggleFavorite(prompt._id);
                                                                        }}
                                                                    >
                                                                        <Star className="mr-2 size-3" />
                                                                        {t`Add to Favorites`}
                                                                    </DropdownMenuItem>
                                                                    <DropdownMenuSeparator />
                                                                    <DropdownMenuItem
                                                                        className="text-destructive"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleDelete(prompt._id);
                                                                        }}
                                                                        variant="destructive"
                                                                    >
                                                                        <Trash2 className="mr-2 size-3" />
                                                                        {t`Delete`}
                                                                    </DropdownMenuItem>
                                                                </DropdownMenuContent>
                                                            </DropdownMenu>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Pagination Controls - Only show if "all" group has multiple pages */}
                            {promptGroups.all.length > ITEMS_PER_PAGE && (
                                <div className="flex items-center justify-between border-t px-2 py-2">
                                    <div className="text-muted-foreground text-xs">
                                        {t`Showing ${Math.min((currentPage - 1) * ITEMS_PER_PAGE + 1, promptGroups.all.length)}-${Math.min(currentPage * ITEMS_PER_PAGE, promptGroups.all.length)} of ${promptGroups.all.length} prompts`}
                                        {promptGroups.favorites.length > 0 && (
                                            <span className="ml-1">
                                                {t`+ ${plural(promptGroups.favorites.length, { one: "# favorite", other: "# favorites" })}`}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button
                                            disabled={currentPage === 1}
                                            onClick={() => setCurrentPage((previous) => Math.max(1, previous - 1))}
                                            size="icon-xs"
                                            variant="ghost"
                                        >
                                            <ChevronLeft className="size-3" />
                                        </Button>
                                        <Button
                                            disabled={!paginatedGroups.hasMoreAll}
                                            onClick={() => setCurrentPage((previous) => previous + 1)}
                                            size="icon-xs"
                                            variant="ghost"
                                        >
                                            <ChevronRight className="size-3" />
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </ScrollArea>
            </div>

            <PromptFormDialog
                editingPrompt={editingPrompt}
                onClose={() => {
                    setIsDialogOpen(false);
                    setEditingPrompt(null);
                }}
                onSubmit={handleSubmit}
                open={isDialogOpen}
            />

            {fillDialogPrompt && (
                <VariableFillDialog
                    existingValues={variableValues}
                    onCancel={handleFillDialogCancel}
                    onUse={handleFillDialogUse}
                    onUseAnyway={handleFillDialogUseAnyway}
                    open={!!fillDialogPrompt}
                    prompt={fillDialogPrompt}
                />
            )}
            <DeleteConfirmationDialog
                description={t`This will permanently delete the prompt "${promptToDelete?.name}". This action cannot be undone.`}
                isDeleting={isDeleting}
                itemName={promptToDelete?.name}
                onConfirm={handleConfirmDelete}
                onOpenChange={(open) => {
                    if (!open) {
                        setPromptToDelete(null);
                    }
                }}
                open={!!promptToDelete}
                title={t`Delete Prompt`}
            />
        </div>
    );
};

export default PromptsSidebarTab;
