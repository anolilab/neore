"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Input } from "@neore/ui/components/input";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { FileText, Plus, Search, Star, Users } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useMemo, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import type { FlatPage, MoveTarget } from "../lib/page-tree";
import { buildPageTree } from "../lib/page-tree";
import PageTreeItem, { PAGE_DRAG_TYPE } from "./page-tree-item";

const SEARCH_DEBOUNCE_MS = 250;

const useDebounced = (value: string, delay: number): string => {
    const [debounced, setDebounced] = useState(value);

    useEffect(() => {
        const timer = setTimeout(setDebounced, delay, value);

        return () => clearTimeout(timer);
    }, [value, delay]);

    return debounced;
};

/** Ancestors of `pageId`, so the tree opens down to the page being viewed. */
const ancestorsOf = (pages: ReadonlyArray<FlatPage>, pageId: string | undefined): string[] => {
    const parentOf = new Map(pages.map((page) => [page._id, page.parentPageId]));
    const result: string[] = [];
    let cursor = pageId ? parentOf.get(pageId) : null;

    while (cursor && !result.includes(cursor)) {
        result.push(cursor);
        cursor = parentOf.get(cursor) ?? null;
    }

    return result;
};

const PagesSidebar: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const navigate = useNavigate();
    const searchId = useId();
    const { pageId: activePageId } = useParams({ strict: false }) as { pageId?: string };
    const [query, setQuery] = useState("");
    const debouncedQuery = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [pendingDelete, setPendingDelete] = useState<FlatPage | null>(null);

    const { data: tree } = useQuery(crpc.pages.functions.listPageTree.queryOptions({}));
    const { data: results } = useQuery(crpc.pages.functions.searchPages.queryOptions(debouncedQuery ? { query: debouncedQuery } : skipToken));

    const createPage = useMutation(crpc.pages.functions.createPage.mutationOptions());
    const movePage = useMutation(crpc.pages.functions.movePage.mutationOptions());
    const setFavorite = useMutation(crpc.pages.functions.setPageFavorite.mutationOptions());
    const deletePage = useMutation(crpc.pages.functions.deletePage.mutationOptions());

    const owned = useMemo(() => (tree?.owned ?? []) as FlatPage[], [tree]);
    const nodes = useMemo(() => buildPageTree(owned), [owned]);
    // Starred pages of both kinds: the user's own and ones shared with them.
    const favorites = [...owned, ...(tree?.shared ?? [])].filter((page) => page.isFavorite);
    const pendingDeleteTitle = pendingDelete?.title || t`Untitled`;
    const resultCount = results?.length ?? 0;
    let searchStatus = t`${resultCount} results`;

    if (results === undefined) {
        searchStatus = t`Searching…`;
    } else if (resultCount === 0) {
        searchStatus = t`No pages found`;
    }

    // Open the tree down to the page being viewed.
    useEffect(() => {
        const ancestors = ancestorsOf(owned, activePageId);

        if (ancestors.length > 0) {
            setExpanded((previous) => (ancestors.every((id) => previous.has(id)) ? previous : new Set([...previous, ...ancestors])));
        }
    }, [owned, activePageId]);

    const handleCreate = async (parentPageId?: string) => {
        try {
            const { pageId } = await createPage.mutateAsync(parentPageId ? { parentPageId: parentPageId as never } : {});

            if (parentPageId) {
                setExpanded((previous) => new Set(previous).add(parentPageId));
            }

            await navigate({ params: { pageId }, to: "/pages/$pageId" });
        } catch (error) {
            showError(error instanceof Error ? error : t`Could not create the page`);
        }
    };

    const handleMove = (pageId: string, target: MoveTarget) => {
        movePage.mutate(
            { index: target.index, pageId: pageId as never, parentPageId: target.parentPageId as never },
            { onError: (error) => showError(error instanceof Error ? error : t`Could not move the page`) },
        );

        if (target.parentPageId) {
            setExpanded((previous) => new Set(previous).add(target.parentPageId as string));
        }
    };

    const handleToggleExpanded = (pageId: string) => {
        setExpanded((previous) => {
            const next = new Set(previous);

            if (next.has(pageId)) {
                next.delete(pageId);
            } else {
                next.add(pageId);
            }

            return next;
        });
    };

    const handleConfirmDelete = async () => {
        if (!pendingDelete) {
            return;
        }

        const deleting = pendingDelete;

        try {
            await deletePage.mutateAsync({ pageId: deleting._id as never });
            setPendingDelete(null);

            if (activePageId === deleting._id || ancestorsOf(owned, activePageId).includes(deleting._id)) {
                await navigate({ to: "/pages" });
            }
        } catch (error) {
            showError(error instanceof Error ? error : t`Could not delete the page`);
        }
    };

    return (
        <aside aria-label={t`Pages`} className="flex h-full w-64 shrink-0 flex-col border-r">
            <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
                <h2 className="text-sm font-semibold">{t`Pages`}</h2>
                <Button
                    aria-label={t`New page`}
                    disabled={createPage.isPending}
                    onClick={() => {
                        void handleCreate();
                    }}
                    size="icon-sm"
                    variant="ghost"
                >
                    <Plus aria-hidden="true" />
                </Button>
            </div>
            <div className="relative px-3 pb-2" role="search">
                <label className="sr-only" htmlFor={searchId}>{t`Search pages`}</label>
                <Search aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-2 left-5 size-3.5" />
                <Input
                    className="h-7 pl-7 text-xs"
                    id={searchId}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t`Search pages`}
                    type="search"
                    value={query}
                />
            </div>
            <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-4 px-2 pb-4">
                    {debouncedQuery ? (
                        <section aria-label={t`Search results`}>
                            <p aria-live="polite" className="text-muted-foreground px-2 pb-1 text-xs" role="status">
                                {searchStatus}
                            </p>
                            <ul>
                                {(results ?? []).map((result) => (
                                    <li key={result._id}>
                                        <Link
                                            className="hover:bg-sidebar-accent/60 block rounded-md px-2 py-1.5"
                                            params={{ pageId: result._id }}
                                            to="/pages/$pageId"
                                        >
                                            <span className="block truncate text-sm">{result.title || t`Untitled`}</span>
                                            {result.snippet && <span className="text-muted-foreground line-clamp-2 text-xs">{result.snippet}</span>}
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ) : (
                        <>
                            {favorites.length > 0 && (
                                <nav aria-label={t`Favorite pages`}>
                                    <h3 className="text-muted-foreground flex items-center gap-1 px-2 pb-1 text-xs font-medium">
                                        <Star aria-hidden="true" className="size-3" />
                                        {t`Favorites`}
                                    </h3>
                                    <ul>
                                        {favorites.map((page) => (
                                            <li key={page._id}>
                                                <Link
                                                    aria-current={activePageId === page._id ? "page" : undefined}
                                                    className="hover:bg-sidebar-accent/60 aria-[current=page]:bg-sidebar-accent flex items-center gap-1.5 rounded-md px-2 py-1 text-sm"
                                                    params={{ pageId: page._id }}
                                                    to="/pages/$pageId"
                                                >
                                                    <span aria-hidden="true" className="w-3.5 text-center text-sm leading-none">
                                                        {page.icon ?? <FileText className="text-muted-foreground size-3.5" />}
                                                    </span>
                                                    <span className="truncate">{page.title || t`Untitled`}</span>
                                                </Link>
                                            </li>
                                        ))}
                                    </ul>
                                </nav>
                            )}
                            <nav aria-label={t`Your pages`}>
                                <h3 className="text-muted-foreground px-2 pb-1 text-xs font-medium">{t`Private`}</h3>
                                {tree && nodes.length === 0 && <p className="text-muted-foreground px-2 text-xs">{t`No pages yet.`}</p>}
                                <ul
                                    // Dropping on the list itself (below the last row) moves to the top level, at the end.
                                    onDragOver={(event) => {
                                        if (event.dataTransfer.types.includes(PAGE_DRAG_TYPE)) {
                                            event.preventDefault();
                                        }
                                    }}
                                    onDrop={(event) => {
                                        const draggedId = event.dataTransfer.getData(PAGE_DRAG_TYPE);

                                        if (draggedId && event.target === event.currentTarget) {
                                            handleMove(draggedId, { index: nodes.length, parentPageId: null });
                                        }
                                    }}
                                >
                                    {nodes.map((node) => (
                                        <PageTreeItem
                                            activePageId={activePageId}
                                            expanded={expanded}
                                            key={node._id}
                                            node={node}
                                            onAddChild={(parentPageId) => {
                                                void handleCreate(parentPageId);
                                            }}
                                            onDelete={setPendingDelete}
                                            onMove={handleMove}
                                            onToggleExpanded={handleToggleExpanded}
                                            onToggleFavorite={(page) => setFavorite.mutate({ isFavorite: !page.isFavorite, pageId: page._id as never })}
                                            pages={owned}
                                        />
                                    ))}
                                </ul>
                            </nav>
                            {(tree?.shared.length ?? 0) > 0 && (
                                <nav aria-label={t`Pages shared with you`}>
                                    <h3 className="text-muted-foreground flex items-center gap-1 px-2 pb-1 text-xs font-medium">
                                        <Users aria-hidden="true" className="size-3" />
                                        {t`Shared with me`}
                                    </h3>
                                    <ul>
                                        {tree?.shared.map((page) => (
                                            <li key={page._id}>
                                                <Link
                                                    aria-current={activePageId === page._id ? "page" : undefined}
                                                    className="hover:bg-sidebar-accent/60 aria-[current=page]:bg-sidebar-accent flex items-center gap-1.5 rounded-md px-2 py-1 text-sm"
                                                    params={{ pageId: page._id }}
                                                    to="/pages/$pageId"
                                                >
                                                    <span aria-hidden="true" className="w-3.5 text-center text-sm leading-none">
                                                        {page.icon ?? <FileText className="text-muted-foreground size-3.5" />}
                                                    </span>
                                                    <span className="truncate">{page.title || t`Untitled`}</span>
                                                </Link>
                                            </li>
                                        ))}
                                    </ul>
                                </nav>
                            )}
                        </>
                    )}
                </div>
            </ScrollArea>
            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={t`The page, every sub-page, its comments and its version history are deleted. This cannot be undone.`}
                loading={deletePage.isPending}
                onConfirm={() => {
                    void handleConfirmDelete();
                }}
                onOpenChange={(open) => !open && setPendingDelete(null)}
                open={pendingDelete !== null}
                title={t`Delete “${pendingDeleteTitle}”?`}
            />
        </aside>
    );
};

export default PagesSidebar;
