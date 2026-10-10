"use client";

import { plural } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Doc, Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { useMutation } from "@tanstack/react-query";
import { ArrowDownAZ, CheckSquare, Clock, Grid3x3, List, Plus, Search, Star, Tag, Trash2, TrendingUp, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useOptimistic, useState } from "react";
import { toast } from "sonner";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import useCheckout from "@/features/billing/hooks/use-checkout";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";

import type { PromptVariable } from "../lib/prompt-variables";
import PromptEmptyState from "./prompt-empty-state";
import PromptFormDialog from "./prompt-form-dialog";
import PromptHistoryDialog from "./prompt-history-dialog";
import PromptItem from "./prompt-item";
import PromptListView from "./prompt-list-view";
import PromptOptimizeDialog from "./prompt-optimize-dialog";

type SortOption = "recent" | "mostUsed" | "recentlyUsed" | "alphabetical";
type ViewMode = "board" | "list";

interface PromptListProps {
    onUsePrompt?: (content: string) => void;
}

const applyOptimisticFavorite = (current: Doc<"prompts">[], { isFavorite, promptId }: { isFavorite: boolean; promptId: string }) =>
    current.map((p) => (p._id === promptId ? { ...p, isFavorite } : p));

const PromptList = ({ onUsePrompt }: PromptListProps) => {
    const { t } = useLingui();
    const { upgradeToast } = useCheckout();
    const crpc = useCRPC();
    const [searchQuery, setSearchQuery] = useState("");
    const [sortBy, setSortBy] = useState<SortOption>("recent");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const selectedTagSet = new Set(selectedTags);
    const [viewMode, setViewMode] = useState<ViewMode>("board");
    const [selectedPromptIds, setSelectedPromptIds] = useState<Set<string>>(new Set());
    const [selectionMode, setSelectionMode] = useState(false);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<Doc<"prompts"> | null>(null);
    const [optimizingPrompt, setOptimizingPrompt] = useState<Doc<"prompts"> | null>(null);
    const [historyPrompt, setHistoryPrompt] = useState<Doc<"prompts"> | null>(null);

    // Auth
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const isLoggedIn = !!sessionData?.user;

    // Fetch prompts using action (with caching)
    const { mutateAsync: getPrompts } = useMutation(useLunoraActionOptions(api.prompts.functions.getPrompts));
    const [promptsBase, setPromptsBase] = useState<Doc<"prompts">[] | undefined>(undefined);

    // Use optimistic updates for favorites
    const [prompts, setOptimisticPrompts] = useOptimistic(promptsBase || [], applyOptimisticFavorite);

    // Fetch prompt count using action (with caching)
    const { mutateAsync: getPromptCount } = useMutation(useLunoraActionOptions(api.prompts.functions.getPromptCount));
    const [promptCount, setPromptCount] = useState<{ canCreate: boolean; count: number; isPremium: boolean; limit: number | null } | undefined>(undefined);

    // Fetch tags using action (with caching)
    const { mutateAsync: getPromptTags } = useMutation(useLunoraActionOptions(api.prompts.functions.getPromptTags));
    const [allTags, setAllTags] = useState<string[] | undefined>(undefined);

    // Load prompts, prompt count, and tags on mount and when sortBy changes
    useEffect(() => {
        let isCancelled = false;

        Promise.all([getPrompts({ sortBy }), getPromptCount({}), getPromptTags({})])
            .then(([promptsResult, count, tags]) => {
                if (isCancelled) {
                    return undefined;
                }

                setPromptsBase(promptsResult as Doc<"prompts">[]);
                setPromptCount(count);
                setAllTags(tags);

                return undefined;
            })
            .catch(() => {
                // Ignore errors - tags are optional
            });

        return () => {
            isCancelled = true;
        };
    }, [getPrompts, getPromptCount, getPromptTags, sortBy]);

    // Mutations
    const { mutateAsync: createPrompt } = useMutation(crpc.prompts.functions.createPrompt.mutationOptions());
    const { mutateAsync: updatePrompt } = useMutation(crpc.prompts.functions.updatePrompt.mutationOptions());
    const { mutateAsync: deletePrompt } = useMutation(crpc.prompts.functions.deletePrompt.mutationOptions());
    const { mutateAsync: toggleFavorite } = useMutation(crpc.prompts.functions.togglePromptFavorite.mutationOptions());
    const { mutate: recordUsage } = useMutation(crpc.prompts.functions.recordPromptUsage.mutationOptions());

    // Filter prompts based on search query and tags
    const filteredPrompts = useMemo(() => {
        if (!prompts) {
            return [];
        }

        let filtered = prompts;

        // Filter by search query
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();

            filtered = filtered.filter(
                (prompt) =>
                    prompt.name.toLowerCase().includes(query) ||
                    prompt.content.toLowerCase().includes(query) ||
                    prompt.description?.toLowerCase().includes(query) ||
                    prompt.tags?.some((tag: string) => tag.toLowerCase().includes(query)) ||
                    // Also search in variable names
                    prompt.variables?.some((v: { name: string }) => v.name.toLowerCase().includes(query)),
            );
        }

        // Filter by selected tags
        if (selectedTags.length > 0) {
            filtered = filtered.filter((prompt) => prompt.tags && selectedTags.some((tag) => prompt.tags?.includes(tag)));
        }

        return filtered;
    }, [prompts, searchQuery, selectedTags]);

    // Group favorites
    const favoritePrompts = useMemo(() => filteredPrompts.filter((p) => p.isFavorite), [filteredPrompts]);
    const otherPrompts = useMemo(() => filteredPrompts.filter((p) => !p.isFavorite), [filteredPrompts]);

    const handleTagToggle = useCallback((tag: string) => {
        setSelectedTags((previous) => (previous.includes(tag) ? previous.filter((selectedTag) => selectedTag !== tag) : [...previous, tag]));
    }, []);

    const handleClearTags = useCallback(() => {
        setSelectedTags([]);
    }, []);

    const handleCreatePrompt = useCallback(() => {
        if (!isLoggedIn) {
            toast.error(t`Please sign in to create prompts`);

            return;
        }

        if (promptCount && !promptCount.canCreate) {
            upgradeToast(t`Free accounts are limited to 3 prompts. Upgrade to Pro for unlimited prompts.`);

            return;
        }

        setEditingPrompt(null);
        setIsDialogOpen(true);
    }, [isLoggedIn, promptCount, t, upgradeToast]);

    const handleEditPrompt = useCallback((prompt: Doc<"prompts">) => {
        setEditingPrompt(prompt);
        setIsDialogOpen(true);
    }, []);

    const handleCloseDialog = useCallback(() => {
        setIsDialogOpen(false);
        setEditingPrompt(null);
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
            variables?: PromptVariable[];
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
                    toast.success(t`Prompt updated successfully`);
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
                    toast.success(t`Prompt created successfully`);
                }
            } catch (error: any) {
                // Check for prompt limit error
                if (error?.data?.code === "PROMPT_LIMIT_REACHED" || error?.message?.includes("PROMPT_LIMIT_REACHED")) {
                    upgradeToast(t`Free accounts are limited to 3 prompts. Upgrade to Pro for unlimited prompts.`);
                } else {
                    toast.error(t`Failed to save prompt`);
                }

                throw error;
            }
        },
        [createPrompt, updatePrompt, t, upgradeToast],
    );

    const handleDelete = useCallback(
        async (promptId: string) => {
            try {
                await deletePrompt({ promptId: promptId as Id<"prompts"> });
                toast.success(t`Prompt deleted`);
            } catch {
                toast.error(t`Failed to delete prompt`);
            }
        },
        [deletePrompt, t],
    );

    const handleDeleteMany = useCallback(
        async (promptIds: string[]) => {
            try {
                // Delete prompts one by one (Lunora doesn't have batch delete)
                for (const promptId of promptIds) {
                    await deletePrompt({ promptId: promptId as Id<"prompts"> });
                }

                toast.success(t`Deleted ${plural(promptIds.length, { one: "# prompt", other: "# prompts" })}`);
                setSelectedPromptIds(new Set());
                setSelectionMode(false);
            } catch {
                toast.error(t`Failed to delete some prompts`);
            }
        },
        [deletePrompt, t],
    );

    const handleSelectPrompt = useCallback(
        (promptId: string, selected: boolean) => {
            setSelectedPromptIds((previous) => {
                const next = new Set(previous);

                if (selected) {
                    next.add(promptId);
                } else {
                    next.delete(promptId);
                }

                return next;
            });

            if (!selectionMode && selected) {
                setSelectionMode(true);
            }
        },
        [selectionMode],
    );

    const handleClearSelection = useCallback(() => {
        setSelectedPromptIds(new Set());
        setSelectionMode(false);
    }, []);

    const handleDeleteSelected = useCallback(async () => {
        const ids = [...selectedPromptIds];

        if (ids.length === 0) {
            return;
        }

        await handleDeleteMany(ids);
    }, [selectedPromptIds, handleDeleteMany]);

    const handleToggleFavorite = useCallback(
        async (promptId: string) => {
            const prompt = prompts.find((p) => p._id === promptId);
            const currentIsFavorite = prompt?.isFavorite ?? false;
            const isNewIsFavorite = !currentIsFavorite;

            // Optimistic update
            setOptimisticPrompts({ isFavorite: isNewIsFavorite, promptId });

            try {
                const isFavorite = await toggleFavorite({ promptId: promptId as Id<"prompts"> });

                // If the server returns a different value, the optimistic update will be reverted
                // and the server value will be used
                if (isFavorite !== isNewIsFavorite) {
                    // Update base state to match server
                    setPromptsBase((previous) => {
                        if (!previous) {
                            return previous;
                        }

                        return previous.map((p) => (p._id === promptId ? { ...p, isFavorite } : p));
                    });
                }

                toast.success(isFavorite ? t`Added to favorites` : t`Removed from favorites`);
            } catch {
                // Optimistic update will be automatically reverted on error
                toast.error(t`Failed to update favorite`);
            }
        },
        [prompts, toggleFavorite, t, setOptimisticPrompts],
    );

    const handleOptimize = useCallback((prompt: Doc<"prompts">) => {
        setOptimizingPrompt(prompt);
    }, []);

    const handleOptimizeClose = useCallback(() => {
        setOptimizingPrompt(null);
    }, []);

    const handleViewHistory = useCallback((prompt: Doc<"prompts">) => {
        setHistoryPrompt(prompt);
    }, []);

    const handleHistoryClose = useCallback(() => {
        setHistoryPrompt(null);
    }, []);

    const handleOptimized = useCallback(
        async (optimizedContent: string) => {
            if (!optimizingPrompt) {
                return;
            }

            try {
                await updatePrompt({
                    changeType: "optimized",
                    content: optimizedContent,
                    note: "Optimized with AI",
                    promptId: optimizingPrompt._id,
                    // `variables` is optional server-side, but codegen emits it as a required
                    // key with an `unknown` value; optimizing never touches the variables.
                    variables: undefined,
                });
            } catch {
                throw new Error("Failed to update prompt");
            }
        },
        [optimizingPrompt, updatePrompt],
    );

    const handleUsePrompt = useCallback(
        (prompt: Doc<"prompts">, temporaryChat = false) => {
            // If onUsePrompt callback is provided (e.g., from sidebar), use it
            if (onUsePrompt) {
                onUsePrompt(prompt.content);
                recordUsage({ promptId: prompt._id });

                return;
            }

            // Otherwise, open a new tab with the promptId query parameter
            // The chat page will load the prompt and configure itself
            const chatUrl = `/chat?promptId=${prompt._id}${temporaryChat ? "&tempChat=true" : ""}`;

            window.open(chatUrl, "_blank");

            // Record usage
            recordUsage({ promptId: prompt._id });
        },
        [onUsePrompt, recordUsage],
    );

    // Loading state
    if (promptsBase === undefined) {
        return (
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <div className="bg-muted h-10 w-64 animate-pulse rounded-lg" />
                    <div className="bg-muted h-9 w-32 animate-pulse rounded-lg" />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {Array.from({ length: 6 }, (_, i) => (
                        <div className="bg-muted h-40 animate-pulse rounded-lg" key={i} />
                    ))}
                </div>
            </div>
        );
    }

    // Empty state
    if (prompts.length === 0) {
        return (
            <>
                <PromptEmptyState isLoggedIn={isLoggedIn} onCreatePrompt={handleCreatePrompt} promptCount={promptCount} />
                <PromptFormDialog onClose={handleCloseDialog} onSubmit={handleSubmit} open={isDialogOpen} />
            </>
        );
    }

    let promptsBody = (
        <div className="space-y-8">
            {/* Favorites Section */}
            {favoritePrompts.length > 0 && (
                <div className="space-y-4">
                    <h2 className="flex items-center gap-2 text-lg font-semibold">
                        <Star className="size-5 fill-yellow-500 text-yellow-500" />
                        {t`Favorites`}
                    </h2>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {favoritePrompts.map((prompt) => (
                            <PromptItem
                                isSelected={selectedPromptIds.has(prompt._id)}
                                key={prompt._id}
                                onDelete={handleDelete}
                                onEdit={handleEditPrompt}
                                onOptimize={handleOptimize}
                                onSelect={handleSelectPrompt}
                                onToggleFavorite={handleToggleFavorite}
                                onUsePrompt={handleUsePrompt}
                                onViewHistory={handleViewHistory}
                                prompt={prompt}
                                selectionMode={selectionMode}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* All Prompts Section */}
            <div className="space-y-4">
                {favoritePrompts.length > 0 && <h2 className="text-lg font-semibold">{t`All Prompts`}</h2>}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {otherPrompts.map((prompt) => (
                        <PromptItem
                            isSelected={selectedPromptIds.has(prompt._id)}
                            key={prompt._id}
                            onDelete={isLoggedIn ? handleDelete : undefined}
                            onEdit={isLoggedIn ? handleEditPrompt : undefined}
                            onOptimize={isLoggedIn ? handleOptimize : undefined}
                            onSelect={isLoggedIn ? handleSelectPrompt : undefined}
                            onToggleFavorite={isLoggedIn ? handleToggleFavorite : undefined}
                            onUsePrompt={handleUsePrompt}
                            onViewHistory={isLoggedIn ? handleViewHistory : undefined}
                            prompt={prompt}
                            selectionMode={selectionMode && isLoggedIn}
                        />
                    ))}
                </div>
            </div>
        </div>
    );

    if (viewMode === "list") {
        promptsBody = (
            <PromptListView
                onDelete={handleDelete}
                onDeleteMany={handleDeleteMany}
                onEdit={handleEditPrompt}
                onOptimize={handleOptimize}
                onToggleFavorite={handleToggleFavorite}
                onUsePrompt={handleUsePrompt}
                onViewHistory={handleViewHistory}
                prompts={filteredPrompts}
            />
        );
    }

    return (
        <>
            <div className="space-y-8">
                {/* Sticky Toolbar */}
                <div className="bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10 -mx-4 -mt-4 px-4 py-4 backdrop-blur-md">
                    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                        <div className="relative flex-1 md:max-w-md">
                            <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                            <Input
                                className="pl-9"
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder={t`Search prompts...`}
                                type="search"
                                value={searchQuery}
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <Select onValueChange={(v) => setSortBy(v as SortOption)} value={sortBy}>
                                <SelectTrigger className="w-40">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="recent">
                                        <div className="flex items-center gap-2">
                                            <Clock className="size-4" />
                                            {t`Recent`}
                                        </div>
                                    </SelectItem>
                                    <SelectItem value="recentlyUsed">
                                        <div className="flex items-center gap-2">
                                            <Clock className="size-4" />
                                            {t`Recently Used`}
                                        </div>
                                    </SelectItem>
                                    <SelectItem value="mostUsed">
                                        <div className="flex items-center gap-2">
                                            <TrendingUp className="size-4" />
                                            {t`Most Used`}
                                        </div>
                                    </SelectItem>
                                    <SelectItem value="alphabetical">
                                        <div className="flex items-center gap-2">
                                            <ArrowDownAZ className="size-4" />
                                            {t`A-Z`}
                                        </div>
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <div className="bg-border mx-2 h-6 w-px" />
                            <div className="bg-muted flex rounded-md p-1" role="tablist">
                                <Button
                                    aria-label={t`Board view`}
                                    className="h-7 px-2"
                                    onClick={() => setViewMode("board")}
                                    size="sm"
                                    variant={viewMode === "board" ? "secondary" : "ghost"}
                                >
                                    <Grid3x3 aria-hidden="true" className="size-4" />
                                </Button>
                                <Button
                                    aria-label={t`List view`}
                                    className="h-7 px-2"
                                    onClick={() => setViewMode("list")}
                                    size="sm"
                                    variant={viewMode === "list" ? "secondary" : "ghost"}
                                >
                                    <List aria-hidden="true" className="size-4" />
                                </Button>
                            </div>
                            <div className="bg-border mx-2 h-6 w-px" />
                            {isLoggedIn && (
                                <Button
                                    onClick={() => {
                                        if (selectionMode) {
                                            handleClearSelection();
                                        } else {
                                            setSelectionMode(true);
                                        }
                                    }}
                                    size="sm"
                                    variant={selectionMode ? "secondary" : "outline"}
                                >
                                    <CheckSquare className="mr-2 size-4" />
                                    {selectionMode ? t`Cancel Selection` : t`Select`}
                                </Button>
                            )}
                            <div className="bg-border mx-2 h-6 w-px" />
                            <Button disabled={promptCount ? !promptCount.canCreate : false} onClick={handleCreatePrompt}>
                                <Plus className="mr-2 size-4" />
                                {t`New Prompt`}
                            </Button>
                        </div>
                    </div>

                    {/* Tag filter */}
                    {allTags && allTags.length > 0 && (
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            <span className="text-muted-foreground flex items-center gap-1 text-sm">
                                <Tag className="size-4" />
                                {t`Filter:`}
                            </span>
                            {allTags.map((tag) => (
                                <Badge
                                    className="cursor-pointer"
                                    key={tag}
                                    onClick={() => handleTagToggle(tag)}
                                    variant={selectedTagSet.has(tag) ? "default" : "outline"}
                                >
                                    {tag}
                                </Badge>
                            ))}
                            {selectedTags.length > 0 && (
                                <Button className="h-6 px-2 text-xs" onClick={handleClearTags} variant="ghost">
                                    <X className="mr-1 size-3" />
                                    {t`Clear`}
                                </Button>
                            )}
                        </div>
                    )}
                </div>

                {/* Selection Toolbar */}
                {selectionMode && selectedPromptIds.size > 0 && (
                    <div className="bg-primary/10 border-primary/20 flex items-center justify-between rounded-lg border p-3">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">
                                <Plural one="# prompt selected" other="# prompts selected" value={selectedPromptIds.size} />
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button onClick={handleDeleteSelected} size="sm" variant="destructive">
                                <Trash2 className="mr-2 size-4" />
                                {t`Delete Selected`}
                            </Button>
                            <Button onClick={handleClearSelection} size="sm" variant="ghost">
                                <X className="mr-2 size-4" />
                                {t`Clear Selection`}
                            </Button>
                        </div>
                    </div>
                )}

                {/* Prompts Content */}
                {filteredPrompts.length === 0 ? (
                    <div className="py-12 text-center">
                        <p className="text-muted-foreground">{t`No prompts found matching your search.`}</p>
                    </div>
                ) : (
                    promptsBody
                )}
            </div>

            <PromptFormDialog editingPrompt={editingPrompt} onClose={handleCloseDialog} onSubmit={handleSubmit} open={isDialogOpen} />

            {optimizingPrompt && (
                <PromptOptimizeDialog onClose={handleOptimizeClose} onOptimized={handleOptimized} open={!!optimizingPrompt} prompt={optimizingPrompt} />
            )}

            {historyPrompt && <PromptHistoryDialog onClose={handleHistoryClose} open={!!historyPrompt} prompt={historyPrompt} />}
        </>
    );
};

export default PromptList;
