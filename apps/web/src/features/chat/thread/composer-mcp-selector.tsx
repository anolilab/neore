"use client";

import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@neore/ui/components/avatar";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import MCPIcon from "@neore/ui/icons/mcp";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Check } from "lucide-react";
import type { FC } from "react";

import { useModelStore } from "@/features/chat/core/stores/model-store";
import { getServerFaviconUrl, getServerInitials } from "@/features/chat/core/utils/mcp";
import { useCRPC } from "@/lib/lunora/crpc";

interface MCPServer {
    enabled: boolean;
    icon?: string;
    name: string;
    protocol: "sse" | "http";
    url: string;
}

/** Max avatars shown in the trigger before collapsing to "+N" */
const MAX_VISIBLE_AVATARS = 3;

const ComposerMCPSelector: FC<{ disabled?: boolean }> = ({ disabled }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: aiPreferences } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));

    const mcpServerNames = useModelStore((state) => state.mcpServerNames);
    const setMCPServerNames = useModelStore((state) => state.setMCPServerNames);

    const servers: MCPServer[] = (aiPreferences?.mcpServers ?? []) as MCPServer[];
    const enabledServers = servers.filter((s) => s.enabled);

    // Don't render if no MCP servers configured
    if (enabledServers.length === 0) {
        return null;
    }

    // If nothing explicitly selected, all enabled servers are active
    const isAllSelected = mcpServerNames.length === 0;
    const selectedNames = new Set(mcpServerNames);
    const activeServers = isAllSelected ? enabledServers : enabledServers.filter((s) => selectedNames.has(s.name));
    const activeCount = activeServers.length;
    const overflowCount = activeCount - MAX_VISIBLE_AVATARS;

    const toggleServer = (name: string) => {
        if (isAllSelected) {
            // Switching from "all" to specific: select everything except this one
            const remaining = enabledServers.flatMap((s) => (s.name === name ? [] : [s.name]));

            setMCPServerNames(remaining);
        } else if (mcpServerNames.includes(name)) {
            // Deselect this server
            const remaining = mcpServerNames.filter((n) => n !== name);

            // If nothing left, go back to "all" (empty array = all selected)
            if (remaining.length === 0) {
                setMCPServerNames([]);
            } else {
                setMCPServerNames(remaining);
            }
        } else {
            // Select this server
            const updated = [...mcpServerNames, name];

            // If all are selected now, reset to empty (= all)
            if (updated.length === enabledServers.length) {
                setMCPServerNames([]);
            } else {
                setMCPServerNames(updated);
            }
        }
    };

    const selectAll = () => {
        setMCPServerNames([]);
    };

    const isServerSelected = (name: string) => isAllSelected || mcpServerNames.includes(name);

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
                                        "bg-sidebar border-border dark:border-sidebar-border/15 hover:bg-accent/50 dark:hover:bg-sidebar-accent/30 hover:border-border dark:hover:border-sidebar-border/50 text-foreground h-7 gap-1.5 px-1.5 dark:text-white",
                                        !isAllSelected &&
                                            "border-purple-500/30 bg-purple-500/10 text-purple-700 hover:border-purple-500/40 hover:bg-purple-500/20 dark:text-purple-300",
                                    )}
                                    variant="outline"
                                >
                                    <AvatarGroup className="-space-x-1.5">
                                        {activeServers.slice(0, MAX_VISIBLE_AVATARS).map((server) => {
                                            const faviconUrl = server.icon || getServerFaviconUrl(server.url);

                                            return (
                                                <Avatar className="size-4" key={server.name} size="sm">
                                                    {faviconUrl && <AvatarImage src={faviconUrl} />}
                                                    <AvatarFallback className="text-[6px]">{getServerInitials(server.name)}</AvatarFallback>
                                                </Avatar>
                                            );
                                        })}
                                        {overflowCount > 0 && <AvatarGroupCount className="size-4 text-[7px] ring-1">+{overflowCount}</AvatarGroupCount>}
                                    </AvatarGroup>
                                    <span className="hidden text-xs sm:inline">{isAllSelected ? t`MCP` : `${activeCount}/${enabledServers.length}`}</span>
                                </Button>
                            }
                        />
                    }
                />
                <TooltipContent side="top" sideOffset={8}>
                    <p>{isAllSelected ? t`All MCP servers active` : t`${activeCount} of ${enabledServers.length} MCP servers active`}</p>
                    {activeServers.length > MAX_VISIBLE_AVATARS && (
                        <ul className="mt-1.5 space-y-1">
                            {activeServers.slice(MAX_VISIBLE_AVATARS).map((s) => (
                                <li className="flex items-center gap-1.5 text-xs" key={s.name}>
                                    <Avatar className="size-3.5" size="sm">
                                        {s.icon && <AvatarImage src={s.icon} />}
                                        <AvatarFallback className="text-[5px]">{getServerInitials(s.name)}</AvatarFallback>
                                    </Avatar>
                                    {s.name}
                                </li>
                            ))}
                        </ul>
                    )}
                </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="min-w-[260px]" sideOffset={6}>
                <div className="text-muted-foreground px-2 py-1.5 text-xs font-semibold">{t`MCP Servers`}</div>
                <DropdownMenuItem className="flex flex-row items-center gap-2.5 py-2" onClick={selectAll}>
                    <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900/40">
                        <MCPIcon className="size-3.5 text-purple-600 dark:text-purple-300" />
                    </div>
                    <div className="flex grow flex-col items-start gap-0.5">
                        <span className="font-medium">{t`All Servers`}</span>
                        <span className="text-muted-foreground text-xs">{t`Use all enabled MCP servers`}</span>
                    </div>
                    {isAllSelected && <Check className="text-primary size-4 shrink-0" />}
                </DropdownMenuItem>
                <div className="bg-border mx-2 my-1 h-px" />
                {enabledServers.map((server) => {
                    const selected = isServerSelected(server.name);
                    const faviconUrl = server.icon || getServerFaviconUrl(server.url);

                    return (
                        <DropdownMenuItem
                            className={clsx("flex flex-row items-center gap-2.5 py-2", !selected && "opacity-50")}
                            key={server.name}
                            onClick={() => toggleServer(server.name)}
                        >
                            <Avatar className="size-6" size="sm">
                                {faviconUrl && <AvatarImage src={faviconUrl} />}
                                <AvatarFallback className="text-[8px]">{getServerInitials(server.name)}</AvatarFallback>
                            </Avatar>
                            <div className="flex grow flex-col items-start gap-0.5">
                                <span className="font-medium">{server.name}</span>
                                <span className="text-muted-foreground max-w-[160px] truncate text-xs">{server.url}</span>
                            </div>
                            {selected && <Check className="text-primary size-4 shrink-0" />}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default ComposerMCPSelector;
