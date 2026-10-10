"use client";

import { useLingui } from "@lingui/react/macro";
import type { Doc } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button, buttonVariants } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Checkbox } from "@neore/ui/components/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import cn from "@neore/ui/utils/cn";
import { Braces, Check, Copy, Edit, History, Hourglass, Play, Sparkles, Star, Trash2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";

import { extractVariables } from "../lib/prompt-variables";

const VARIABLE_TOKEN_RE = /^\{\{[a-z_][\w.]*\}\}$/i;

interface PromptItemProps {
    isSelected?: boolean;
    onDelete?: (id: string) => void;
    onEdit?: (prompt: Doc<"prompts">) => void;
    onOptimize?: (prompt: Doc<"prompts">) => void;
    onSelect?: (id: string, selected: boolean) => void;
    onToggleFavorite?: (id: string) => void;
    onUsePrompt: (prompt: Doc<"prompts">, temporaryChat?: boolean) => void;
    onViewHistory?: (prompt: Doc<"prompts">) => void;
    prompt: Doc<"prompts">;
    selectionMode?: boolean;
}

const PromptItem = ({
    isSelected = false,
    onDelete,
    onEdit,
    onOptimize,
    onSelect,
    onToggleFavorite,
    onUsePrompt,
    onViewHistory,
    prompt,
    selectionMode = false,
}: PromptItemProps) => {
    const { t } = useLingui();
    const [copied, setCopied] = useState(false);
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const cardRef = useRef<HTMLDivElement>(null);

    const handleSelect = useCallback(
        (checked: boolean) => {
            onSelect?.(prompt._id, checked);
        },
        [onSelect, prompt._id],
    );

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(prompt.content);
            setCopied(true);
            toast.success(t`Prompt copied to clipboard`);
            setTimeout(setCopied, 2000, false);
        } catch {
            toast.error(t`Failed to copy prompt`);
        }
    }, [prompt.content, t]);

    const handleUse = useCallback(
        (temporaryChat = false) => {
            onUsePrompt(prompt, temporaryChat);
        },
        [prompt, onUsePrompt],
    );

    const handleEdit = useCallback(() => {
        if (onEdit) {
            onEdit(prompt);
        }
    }, [prompt, onEdit]);

    const handleOptimize = useCallback(() => {
        if (onOptimize) {
            onOptimize(prompt);
        }
    }, [prompt, onOptimize]);

    const handleViewHistory = useCallback(() => {
        if (onViewHistory) {
            onViewHistory(prompt);
        }
    }, [prompt, onViewHistory]);

    // Extract variables from content
    const variables = useMemo(() => extractVariables(prompt.content), [prompt.content]);

    // Truncate content for display and highlight variables
    const truncatedContent = useMemo(() => {
        const maxLength = 150;
        const content = prompt.content.length > maxLength ? `${prompt.content.slice(0, maxLength)}...` : prompt.content;

        // Replace variables with highlighted spans
        return content.split(/(\{\{[a-z_][\w.]*\}\})/gi).map((part, index) => {
            if (VARIABLE_TOKEN_RE.test(part)) {
                return (
                    <code className="bg-primary/10 text-primary rounded px-1 text-xs" key={index}>
                        {part}
                    </code>
                );
            }

            return part;
        });
    }, [prompt.content]);

    const handleCardClick = useCallback(
        (e: React.MouseEvent) => {
            if (!selectionMode) {
                return;
            }

            e.preventDefault();
            handleSelect(!isSelected);
        },
        [selectionMode, isSelected, handleSelect],
    );

    return (
        <Card
            className={cn(
                "group hover:border-primary/50 relative flex flex-col transition-all hover:shadow-lg",
                isSelected && "border-primary ring-primary/20 ring-2",
                selectionMode && "cursor-pointer",
            )}
            onClick={selectionMode ? handleCardClick : undefined}
            ref={cardRef}
        >
            <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-start gap-2">
                        {selectionMode && (
                            <Checkbox checked={isSelected} className="mt-0.5" onCheckedChange={handleSelect} onClick={(e) => e.stopPropagation()} />
                        )}
                        <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                                <CardTitle className="truncate text-base font-semibold">{prompt.name}</CardTitle>
                            </div>
                            {prompt.description && <CardDescription className="line-clamp-2 text-xs">{prompt.description}</CardDescription>}
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        {onEdit && (
                            <Button
                                className="opacity-0 transition-opacity group-hover:opacity-100"
                                onClick={handleEdit}
                                size="icon-sm"
                                title={t`Edit Prompt`}
                                variant="ghost"
                            >
                                <Edit className="size-4" />
                            </Button>
                        )}
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                render={
                                    <Button className="opacity-0 transition-opacity group-hover:opacity-100" size="icon-sm" variant="ghost">
                                        <Play className="size-4" />
                                    </Button>
                                }
                            />
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleUse(false)}>
                                    <Play className="mr-2 size-4" />
                                    {t`Use in Chat`}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleUse(true)}>
                                    <Hourglass className="mr-2 size-4" />
                                    {t`Use in Temp Chat`}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={handleCopy}>
                                    {copied ? <Check className="mr-2 size-4" /> : <Copy className="mr-2 size-4" />}
                                    {t`Copy to Clipboard`}
                                </DropdownMenuItem>
                                {onOptimize && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onClick={handleOptimize}>
                                            <Sparkles className="mr-2 size-4" />
                                            {t`Optimize with AI`}
                                        </DropdownMenuItem>
                                    </>
                                )}
                                {onViewHistory && (
                                    <DropdownMenuItem onClick={handleViewHistory}>
                                        <History className="mr-2 size-4" />
                                        {t`View History`}
                                    </DropdownMenuItem>
                                )}
                                {(onEdit || onToggleFavorite) && (
                                    <>
                                        <DropdownMenuSeparator />
                                        {onEdit && (
                                            <DropdownMenuItem onClick={handleEdit}>
                                                <Edit className="mr-2 size-4" />
                                                {t`Edit`}
                                            </DropdownMenuItem>
                                        )}
                                        {onToggleFavorite && (
                                            <DropdownMenuItem onClick={() => onToggleFavorite(prompt._id)}>
                                                <Star className={`mr-2 size-4 ${prompt.isFavorite ? "fill-current" : ""}`} />
                                                {prompt.isFavorite ? t`Remove from Favorites` : t`Add to Favorites`}
                                            </DropdownMenuItem>
                                        )}
                                    </>
                                )}
                                {onDelete && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem className="text-destructive" onClick={() => setShowDeleteDialog(true)}>
                                            <Trash2 className="mr-2 size-4" />
                                            {t`Delete`}
                                        </DropdownMenuItem>
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="flex-1 pb-3">
                {/* Content Preview */}
                <div
                    aria-label={t`Copy Prompt`}
                    className="bg-muted/50 group/preview hover:bg-muted/80 text-muted-foreground relative cursor-pointer rounded-md p-3 font-mono text-sm transition-colors"
                    onClick={handleCopy}
                    onKeyDown={(e) => {
                        if (!(e.key === "Enter" || e.key === " ")) {
                            return;
                        }

                        e.preventDefault();
                        void handleCopy();
                    }}
                    role="button"
                    tabIndex={0}
                >
                    <div className="line-clamp-4 break-words whitespace-pre-wrap">{truncatedContent}</div>
                    <div className="bg-background/50 absolute inset-0 flex items-center justify-center rounded-md opacity-0 backdrop-blur-[1px] transition-opacity group-hover/preview:opacity-100">
                        {/* A span styled as a button: the whole preview is the button, and a nested one would break its semantics. */}
                        <span className={buttonVariants({ className: "shadow-sm", size: "sm", variant: "secondary" })}>
                            {copied ? (
                                <>
                                    <Check className="mr-2 size-4" />
                                    {t`Copied!`}
                                </>
                            ) : (
                                <>
                                    <Copy className="mr-2 size-4" />
                                    {t`Copy Prompt`}
                                </>
                            )}
                        </span>
                    </div>
                </div>

                {/* Footer Info */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1.5">
                        {prompt.tags &&
                            prompt.tags.slice(0, 3).map((tag: string) => (
                                <Badge className="h-5 px-1.5 text-[10px] font-normal" key={tag} variant="secondary">
                                    {tag}
                                </Badge>
                            ))}
                        {prompt.tags && prompt.tags.length > 3 && (
                            <span className="text-muted-foreground self-center text-[10px]">+{prompt.tags.length - 3}</span>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        {variables.length > 0 && (
                            <Badge className="h-5 gap-1 px-1.5 text-[10px] font-normal" variant="outline">
                                <Braces className="size-3" />
                                {variables.length}
                            </Badge>
                        )}
                        {prompt.isFavorite && <Star className="size-3 fill-current text-yellow-500" />}
                    </div>
                </div>
            </CardContent>
            {onDelete && (
                <DeleteConfirmationDialog
                    description={t`This will permanently delete the prompt "${prompt.name}". This action cannot be undone.`}
                    itemName={prompt.name}
                    onConfirm={() => {
                        onDelete(prompt._id);
                        setShowDeleteDialog(false);
                    }}
                    onOpenChange={setShowDeleteDialog}
                    open={showDeleteDialog}
                    title={t`Delete Prompt`}
                />
            )}
        </Card>
    );
};

export default PromptItem;
