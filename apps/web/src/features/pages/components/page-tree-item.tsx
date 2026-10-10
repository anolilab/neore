"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@neore/ui/components/dropdown-menu";
import cn from "@neore/ui/utils/cn";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronRight, FileText, IndentDecrease, IndentIncrease, MoreHorizontal, Plus, Star, StarOff, Trash2 } from "lucide-react";
import type { DragEvent, FC } from "react";
import { useState } from "react";

import type { FlatPage, MoveTarget, PageNode } from "../lib/page-tree";
import { dropTarget, menuMoves } from "../lib/page-tree";

export const PAGE_DRAG_TYPE = "application/x-neore-page";

interface PageTreeItemProps {
    activePageId: string | undefined;
    expanded: ReadonlySet<string>;
    node: PageNode;
    onAddChild: (parentPageId: string) => void;
    onDelete: (page: FlatPage) => void;
    onMove: (pageId: string, target: MoveTarget) => void;
    onToggleExpanded: (pageId: string) => void;
    onToggleFavorite: (page: FlatPage) => void;
    pages: ReadonlyArray<FlatPage>;
}

type DropPosition = "after" | "before" | "inside";

const dropPositionFor = (event: DragEvent<HTMLElement>): DropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = (event.clientY - rect.top) / rect.height;

    if (offset < 0.25) {
        return "before";
    }

    return offset > 0.75 ? "after" : "inside";
};

/**
 * One row of the page tree, recursively. Moves are available two ways: drag and
 * drop (pointer), and the row's menu (keyboard and screen readers) — the menu is
 * the accessible path, drag is a shortcut.
 */
const PageTreeItem: FC<PageTreeItemProps> = ({ activePageId, expanded, node, onAddChild, onDelete, onMove, onToggleExpanded, onToggleFavorite, pages }) => {
    const { t } = useLingui();
    const [dropPosition, setDropPosition] = useState<DropPosition | null>(null);
    const isExpanded = expanded.has(node._id);
    const hasChildren = node.children.length > 0;
    const moves = menuMoves(pages, node._id);
    const title = node.title || t`Untitled`;

    return (
        <li>
            <div
                className={cn(
                    "group hover:bg-sidebar-accent/60 relative flex items-center gap-0.5 rounded-md pr-1 text-sm",
                    activePageId === node._id && "bg-sidebar-accent text-sidebar-accent-foreground",
                    dropPosition === "inside" && "ring-primary ring-2",
                    dropPosition === "before" && "before:bg-primary before:absolute before:inset-x-0 before:-top-px before:h-0.5",
                    dropPosition === "after" && "after:bg-primary after:absolute after:inset-x-0 after:-bottom-px after:h-0.5",
                )}
                draggable
                onDragLeave={() => setDropPosition(null)}
                onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(PAGE_DRAG_TYPE)) {
                        return;
                    }

                    event.preventDefault();
                    setDropPosition(dropPositionFor(event));
                }}
                onDragStart={(event) => {
                    const { dataTransfer } = event;

                    dataTransfer.setData(PAGE_DRAG_TYPE, node._id);
                    dataTransfer.effectAllowed = "move";
                }}
                onDrop={(event) => {
                    event.preventDefault();

                    const draggedId = event.dataTransfer.getData(PAGE_DRAG_TYPE);
                    const position = dropPositionFor(event);

                    setDropPosition(null);

                    if (!draggedId) {
                        return;
                    }

                    const target = dropTarget(pages, draggedId, node._id, position);

                    if (target) {
                        onMove(draggedId, target);
                    }
                }}
                style={{ paddingLeft: `${String(node.depth * 12 + 4)}px` }}
            >
                {hasChildren ? (
                    <button
                        aria-expanded={isExpanded}
                        aria-label={isExpanded ? t`Collapse ${title}` : t`Expand ${title}`}
                        className="hover:bg-muted text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded"
                        onClick={() => onToggleExpanded(node._id)}
                        type="button"
                    >
                        <ChevronRight
                            aria-hidden="true"
                            className={cn("size-3.5 transition-transform motion-reduce:transition-none", isExpanded && "rotate-90")}
                        />
                    </button>
                ) : (
                    <span aria-hidden="true" className="size-5 shrink-0" />
                )}
                <Link
                    aria-current={activePageId === node._id ? "page" : undefined}
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-1"
                    params={{ pageId: node._id }}
                    to="/pages/$pageId"
                >
                    {node.icon ? (
                        <span aria-hidden="true" className="shrink-0 text-sm leading-none">
                            {node.icon}
                        </span>
                    ) : (
                        <FileText aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <span className={cn("truncate", !node.title && "text-muted-foreground italic")}>{title}</span>
                </Link>
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button
                                aria-label={t`Actions for ${title}`}
                                className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
                                size="icon-xs"
                                variant="ghost"
                            >
                                <MoreHorizontal aria-hidden="true" />
                            </Button>
                        }
                    />
                    <DropdownMenuContent align="start" className="w-52">
                        <DropdownMenuItem onClick={() => onAddChild(node._id)}>
                            <Plus aria-hidden="true" className="mr-2 size-4" />
                            {t`Add sub-page`}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onToggleFavorite(node)}>
                            {node.isFavorite ? <StarOff aria-hidden="true" className="mr-2 size-4" /> : <Star aria-hidden="true" className="mr-2 size-4" />}
                            {node.isFavorite ? t`Remove from favorites` : t`Add to favorites`}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled={!moves.up} onClick={() => moves.up && onMove(node._id, moves.up)}>
                            <ArrowUp aria-hidden="true" className="mr-2 size-4" />
                            {t`Move up`}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!moves.down} onClick={() => moves.down && onMove(node._id, moves.down)}>
                            <ArrowDown aria-hidden="true" className="mr-2 size-4" />
                            {t`Move down`}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!moves.indent} onClick={() => moves.indent && onMove(node._id, moves.indent)}>
                            <IndentIncrease aria-hidden="true" className="mr-2 size-4" />
                            {t`Nest under previous page`}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!moves.outdent} onClick={() => moves.outdent && onMove(node._id, moves.outdent)}>
                            <IndentDecrease aria-hidden="true" className="mr-2 size-4" />
                            {t`Move out one level`}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive" onClick={() => onDelete(node)}>
                            <Trash2 aria-hidden="true" className="mr-2 size-4" />
                            {t`Delete`}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            {hasChildren && isExpanded && (
                <ul>
                    {node.children.map((child) => (
                        <PageTreeItem
                            activePageId={activePageId}
                            expanded={expanded}
                            key={child._id}
                            node={child}
                            onAddChild={onAddChild}
                            onDelete={onDelete}
                            onMove={onMove}
                            onToggleExpanded={onToggleExpanded}
                            onToggleFavorite={onToggleFavorite}
                            pages={pages}
                        />
                    ))}
                </ul>
            )}
        </li>
    );
};

export default PageTreeItem;
