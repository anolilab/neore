import { Plural, useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Check, ExternalLink, Loader2, Search } from "lucide-react";
import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";

import { getServerFaviconUrl, getServerInitials } from "@/features/chat/core/utils/mcp";
import { useAction } from "@/lib/lunora/crpc";

import { POPULAR_MCP_SERVERS } from "./popular-servers";
import type { CatalogServer } from "./types";
import { hasUnresolvedPlaceholder, isCatalogServerAdded, preferredRemote } from "./utilities";

const SEARCH_DEBOUNCE_MS = 300;

const useDebouncedValue = <T,>(value: T, delayMs: number): T => {
    const [debounced, setDebounced] = useState(value);

    useEffect(() => {
        const timer = setTimeout(setDebounced, delayMs, value);

        return () => clearTimeout(timer);
    }, [value, delayMs]);

    return debounced;
};

/** True when installing needs input beyond one click: credentials or URL variables. */
const needsSetup = (server: CatalogServer): boolean => {
    const remote = preferredRemote(server);

    return Boolean(server.authRequired) || Boolean(remote && (remote.headers.some((h) => h.isRequired) || hasUnresolvedPlaceholder(remote.url)));
};

const CatalogCard: FC<{ disabled: boolean; isAdded: boolean; onInstall: (server: CatalogServer) => void; server: CatalogServer }> = ({
    disabled,
    isAdded,
    onInstall,
    server,
}) => {
    const { t } = useLingui();
    const remote = preferredRemote(server);
    const icon = server.icon ?? getServerFaviconUrl(server.websiteUrl ?? remote?.url ?? "");
    const link = server.websiteUrl ?? server.repositoryUrl;

    return (
        <li className="flex items-start gap-3 rounded-lg border p-3">
            <Avatar className="mt-0.5 size-8 shrink-0" size="sm">
                {icon && <AvatarImage alt="" src={icon} />}
                <AvatarFallback className="text-[8px]">{getServerInitials(server.title)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 grow flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{server.title}</span>
                    {remote && (
                        <Badge className="px-1.5 py-0 text-[10px]" variant="outline">
                            {remote.protocol.toUpperCase()}
                        </Badge>
                    )}
                    {needsSetup(server) && (
                        <Badge className="px-1.5 py-0 text-[10px]" variant="outline">
                            {server.authRequired ? t`API key` : t`Setup required`}
                        </Badge>
                    )}
                </div>
                {server.description && <p className="text-muted-foreground line-clamp-2 text-xs">{server.description}</p>}
                {remote && <p className="text-muted-foreground max-w-full truncate text-xs">{remote.url}</p>}
                {link && (
                    <a
                        className="text-muted-foreground inline-flex w-fit items-center gap-1 text-xs underline"
                        href={link}
                        rel="noopener noreferrer"
                        target="_blank"
                    >
                        {t`Details`}
                        <span className="sr-only">{t`about ${server.title} (opens in a new tab)`}</span>
                        <ExternalLink aria-hidden="true" className="size-3" />
                    </a>
                )}
            </div>
            <Button
                aria-label={isAdded ? t`${server.title} already added` : t`Add ${server.title}`}
                className="h-7 shrink-0 text-xs"
                disabled={isAdded || disabled || !remote}
                onClick={() => onInstall(server)}
                size="sm"
                variant="outline"
            >
                {isAdded ? (
                    <>
                        <Check aria-hidden="true" className="mr-1 size-3" />
                        {t`Added`}
                    </>
                ) : (
                    t`Add`
                )}
            </Button>
        </li>
    );
};

export interface MCPServerCatalogProps {
    /** URLs of the servers the user already has, to mark catalogue entries as added. */
    configuredUrls: ReadonlySet<string>;
    /** The add/edit form is open; installing another server would clobber it. */
    disabled: boolean;
    onInstall: (server: CatalogServer) => void;
}

/**
 * Browse the official MCP Registry (remote servers only) with search and paging.
 * Falls back to a curated list when the registry cannot be reached.
 */
export const MCPServerCatalog: FC<MCPServerCatalogProps> = ({ configuredUrls, disabled, onInstall }) => {
    const { i18n, t } = useLingui();
    const listRegistry = useAction(api.chat.mcp_registry.listMcpRegistryServers);

    const [search, setSearch] = useState("");
    const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);

    const registry = useInfiniteQuery({
        queryFn: ({ pageParam }) => listRegistry({ cursor: pageParam, search: debouncedSearch || undefined }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage: Awaited<ReturnType<typeof listRegistry>>) => (lastPage.ok ? lastPage.nextCursor : undefined),
        queryKey: ["mcp-registry", debouncedSearch],
        retry: false,
        staleTime: 5 * 60 * 1000,
    });

    const firstPage = registry.data?.pages[0];
    const isUnavailable = registry.isError || firstPage?.ok === false;

    const servers = useMemo<CatalogServer[]>(() => {
        if (isUnavailable) {
            const needle = debouncedSearch.toLowerCase();
            const popular: CatalogServer[] = POPULAR_MCP_SERVERS.map((server) => {
                return { ...server, description: i18n._(server.description) };
            });

            return needle
                ? popular.filter((server) => server.title.toLowerCase().includes(needle) || server.description.toLowerCase().includes(needle))
                : popular;
        }

        return (registry.data?.pages ?? []).flatMap((page) => (page.ok ? page.servers : []));
    }, [debouncedSearch, i18n, isUnavailable, registry.data?.pages]);

    const isInitialLoad = registry.isPending && !isUnavailable;

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{t`MCP Registry`}</CardTitle>
                <CardDescription className="text-muted-foreground mt-1 text-xs">
                    {t`One-click setup for remote servers from the official MCP Registry. Only servers reachable over HTTP or SSE are listed.`}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="relative">
                    <Label className="sr-only" htmlFor="mcp-registry-search">
                        {t`Search MCP servers`}
                    </Label>
                    <Search aria-hidden="true" className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                    <Input
                        className="pl-8"
                        id="mcp-registry-search"
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t`Search servers…`}
                        type="search"
                        value={search}
                    />
                </div>

                {isUnavailable && (
                    <div
                        className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                        role="status"
                    >
                        <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                        <p>{t`The MCP Registry is unavailable right now. Showing popular servers instead.`}</p>
                    </div>
                )}

                <div aria-live="polite" className="sr-only" role="status">
                    {isInitialLoad ? t`Loading servers…` : <Plural one="# server shown" other="# servers shown" value={servers.length} />}
                </div>

                {isInitialLoad && (
                    <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
                        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                        {t`Loading servers…`}
                    </div>
                )}
                {!isInitialLoad && servers.length === 0 && (
                    <p className="text-muted-foreground py-8 text-center text-sm">{t`No remote MCP servers match your search.`}</p>
                )}
                {!isInitialLoad && servers.length > 0 && (
                    <ul className="grid gap-3 sm:grid-cols-2">
                        {servers.map((server) => (
                            <CatalogCard
                                disabled={disabled}
                                isAdded={isCatalogServerAdded(server, configuredUrls)}
                                key={server.id}
                                onInstall={onInstall}
                                server={server}
                            />
                        ))}
                    </ul>
                )}

                {!isUnavailable && registry.hasNextPage && (
                    <div className="flex justify-center">
                        <Button disabled={registry.isFetchingNextPage} onClick={() => registry.fetchNextPage()} size="sm" variant="outline">
                            {registry.isFetchingNextPage && <Loader2 aria-hidden="true" className="mr-2 size-3.5 animate-spin" />}
                            {t`Load more`}
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
};
