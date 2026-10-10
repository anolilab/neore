"use client";

import { plural } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import type { Doc } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import DataGrid from "@neore/ui/components/data-grid/data-grid";
import DataGridKeyboardShortcuts from "@neore/ui/components/data-grid/data-grid-keyboard-shortcuts";
import getDataGridSelectColumn from "@neore/ui/components/data-grid/data-grid-select-column";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import type { UseDataGridProps } from "@neore/ui/hooks/use-data-grid";
import { useDataGrid } from "@neore/ui/hooks/use-data-grid";
import { Braces, Check, Copy, Edit, History, MoreVertical, Play, Sparkles, Star, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";

import { extractVariables } from "../lib/prompt-variables";

interface PromptListViewProps {
    onDelete: (id: string) => void;
    onDeleteMany?: (ids: string[]) => void | Promise<void>;
    onEdit: (prompt: Doc<"prompts">) => void;
    onOptimize: (prompt: Doc<"prompts">) => void;
    onToggleFavorite: (id: string) => void;
    onUsePrompt: (prompt: Doc<"prompts">) => void;
    onViewHistory: (prompt: Doc<"prompts">) => void;
    prompts: Doc<"prompts">[];
}

const PromptListView = ({ onDelete, onDeleteMany, onEdit, onOptimize, onToggleFavorite, onUsePrompt, onViewHistory, prompts }: PromptListViewProps) => {
    const { t } = useLingui();
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [promptToDelete, setPromptToDelete] = useState<Doc<"prompts"> | null>(null);
    const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

    const handleCopy = useCallback(
        async (prompt: Doc<"prompts">) => {
            try {
                await navigator.clipboard.writeText(prompt.content);
                setCopiedId(prompt._id);
                toast.success(t`Prompt copied to clipboard`);
                setTimeout(setCopiedId, 2000, null);
            } catch {
                toast.error(t`Failed to copy prompt`);
            }
        },
        [t],
    );

    const handleBulkDelete = useCallback(
        async (rows: Doc<"prompts">[], _rowIndices: number[]) => {
            if (!onDeleteMany) {
                // Fallback to individual deletes if bulk delete not provided
                for (const prompt of rows) {
                    onDelete(prompt._id);
                }

                return;
            }

            const ids = rows.map((row) => row._id);

            await onDeleteMany(ids);
            toast.success(t`Deleted ${plural(ids.length, { one: "# prompt", other: "# prompts" })}`);
        },
        [onDelete, onDeleteMany, t],
    );

    const columns = useMemo<UseDataGridProps<Doc<"prompts">>["columns"]>(
        () => [
            getDataGridSelectColumn<Doc<"prompts">>(),
            {
                accessorKey: "isFavorite",
                cell: ({ row }) => {
                    const prompt = row.original;

                    return prompt.isFavorite ? <Star className="size-4 fill-current text-yellow-500" /> : null;
                },
                enableResizing: false,
                header: "",
                id: "favorite",
                size: 40,
            },
            {
                accessorKey: "name",
                cell: ({ row }) => {
                    const prompt = row.original;

                    return (
                        <div className="flex items-center gap-2">
                            <span className="font-medium">{prompt.name}</span>
                            {prompt.isFavorite && <Star className="size-3 fill-current text-yellow-500" />}
                        </div>
                    );
                },
                header: t`Name`,
                id: "name",
                meta: {
                    label: t`Name`,
                },
                minSize: 150,
                size: 200,
            },
            {
                accessorKey: "description",
                cell: ({ row }) => {
                    const prompt = row.original;

                    return prompt.description ? (
                        <span className="text-muted-foreground text-sm">{prompt.description}</span>
                    ) : (
                        <span className="text-muted-foreground/50 text-sm italic">{t`No description`}</span>
                    );
                },
                header: t`Description`,
                id: "description",
                meta: {
                    label: t`Description`,
                },
                minSize: 150,
                size: 250,
            },
            {
                accessorKey: "content",
                cell: ({ row }) => {
                    const prompt = row.original;
                    const truncated = prompt.content.length > 200 ? `${prompt.content.slice(0, 200)}...` : prompt.content;

                    return <div className="text-muted-foreground font-mono text-xs">{truncated}</div>;
                },
                header: t`Content`,
                id: "content",
                meta: {
                    label: t`Content`,
                },
                minSize: 200,
                size: 400,
            },
            {
                accessorKey: "tags",
                cell: ({ row }) => {
                    const prompt = row.original;

                    if (!prompt.tags || prompt.tags.length === 0) {
                        return null;
                    }

                    return (
                        <div className="flex flex-wrap gap-1">
                            {prompt.tags.slice(0, 3).map((tag: string) => (
                                <Badge className="h-5 px-1.5 text-[10px] font-normal" key={tag} variant="secondary">
                                    {tag}
                                </Badge>
                            ))}
                            {prompt.tags.length > 3 && <span className="text-muted-foreground self-center text-[10px]">+{prompt.tags.length - 3}</span>}
                        </div>
                    );
                },
                header: t`Tags`,
                id: "tags",
                minSize: 150,
                size: 200,
            },
            {
                accessorKey: "variables",
                cell: ({ row }) => {
                    const prompt = row.original;
                    const variables = extractVariables(prompt.content);

                    return variables.length > 0 ? (
                        <Badge className="h-5 gap-1 px-1.5 text-[10px] font-normal" variant="outline">
                            <Braces className="size-3" />
                            {variables.length}
                        </Badge>
                    ) : null;
                },
                enableResizing: false,
                header: t`Variables`,
                id: "variables",
                size: 100,
            },
            {
                cell: ({ row }) => {
                    const prompt = row.original;

                    return (
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                render={
                                    <Button size="icon-sm" variant="ghost">
                                        <MoreVertical className="size-4" />
                                    </Button>
                                }
                            />
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => onUsePrompt(prompt)}>
                                    <Play className="mr-2 size-4" />
                                    {t`Use Prompt`}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleCopy(prompt)}>
                                    {copiedId === prompt._id ? <Check className="mr-2 size-4" /> : <Copy className="mr-2 size-4" />}
                                    {t`Copy to Clipboard`}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => onOptimize(prompt)}>
                                    <Sparkles className="mr-2 size-4" />
                                    {t`Optimize with AI`}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onViewHistory(prompt)}>
                                    <History className="mr-2 size-4" />
                                    {t`View History`}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => onEdit(prompt)}>
                                    <Edit className="mr-2 size-4" />
                                    {t`Edit`}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onToggleFavorite(prompt._id)}>
                                    <Star className={`mr-2 size-4 ${prompt.isFavorite ? "fill-current" : ""}`} />
                                    {prompt.isFavorite ? t`Remove from Favorites` : t`Add to Favorites`}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-destructive" onClick={() => setPromptToDelete(prompt)}>
                                    <Trash2 className="mr-2 size-4" />
                                    {t`Delete`}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    );
                },
                enableResizing: false,
                enableSorting: false,
                header: "",
                id: "actions",
                size: 50,
            },
        ],
        [t, copiedId, onEdit, onOptimize, onToggleFavorite, onUsePrompt, onViewHistory, handleCopy],
    );

    const { table, ...dataGridProps } = useDataGrid({
        columns,
        data: prompts,
        enableSearch: true,
        getRowId: (row) => row._id,
        onRowsDelete: handleBulkDelete,
        readOnly: true,
    });

    const selectedRows = table.getFilteredSelectedRowModel().rows;
    const selectedCount = selectedRows.length;
    const hasSelection = selectedCount > 0;

    const handleClearSelection = useCallback(() => {
        table.resetRowSelection();
    }, [table]);

    const handleDeleteSelected = useCallback(() => {
        setShowBulkDeleteDialog(true);
    }, []);

    const handleConfirmBulkDelete = useCallback(async () => {
        const rowsToDelete = selectedRows.map((row) => row.original);

        await handleBulkDelete(
            rowsToDelete,
            selectedRows.map((row) => row.index),
        );
        table.resetRowSelection();
        setShowBulkDeleteDialog(false);
    }, [selectedRows, handleBulkDelete, table]);

    return (
        <>
            {/* Selection Toolbar */}
            {hasSelection && (
                <div className="bg-primary/10 border-primary/20 mb-4 flex items-center justify-between rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                            <Plural one="# prompt selected" other="# prompts selected" value={selectedCount} />
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
            <DataGridKeyboardShortcuts enableSearch={!!dataGridProps.searchState} />
            <DataGrid table={table} {...dataGridProps} height={600} />
            <DeleteConfirmationDialog
                description={t`This will permanently delete the prompt "${promptToDelete?.name}". This action cannot be undone.`}
                itemName={promptToDelete?.name}
                onConfirm={() => {
                    if (!promptToDelete) {
                        return;
                    }

                    onDelete(promptToDelete._id);
                    setPromptToDelete(null);
                }}
                onOpenChange={(open) => {
                    if (!open) {
                        setPromptToDelete(null);
                    }
                }}
                open={!!promptToDelete}
                title={t`Delete Prompt`}
            />
            <DeleteConfirmationDialog
                description={t`Are you sure you want to delete ${plural(selectedCount, { one: "# prompt", other: "# prompts" })}? This action cannot be undone.`}
                onConfirm={handleConfirmBulkDelete}
                onOpenChange={setShowBulkDeleteDialog}
                open={showBulkDeleteDialog}
                title={t`Delete Prompts`}
            />
        </>
    );
};

export default PromptListView;
