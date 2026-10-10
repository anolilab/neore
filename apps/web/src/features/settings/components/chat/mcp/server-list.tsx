import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Switch } from "@neore/ui/components/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { KeyRound, Loader2, LogOut, PlugZap, Trash2 } from "lucide-react";
import type { FC } from "react";

import { getServerFaviconUrl, getServerInitials } from "@/features/chat/core/utils/mcp";

import { StatusIndicator, ToolChips } from "./status-indicator";
import type { MCPServerConfig, MCPServerSignIn, ServerStatusInfo } from "./types";
import { isSensitiveKey, maskValue, serverKey } from "./utilities";

export interface MCPServerListProps {
    editingIndex: number | null;
    onDelete: (index: number) => void;
    onEdit: (index: number) => void;
    onSignIn: (server: MCPServerConfig) => void;
    onSignOut: (server: MCPServerConfig) => void;
    onTest: (server: MCPServerConfig) => void;
    onToggle: (index: number, enabled: boolean) => void;
    servers: MCPServerConfig[];
    /** Server name currently starting a sign-in, if any. */
    signingIn?: string;
    /** Stored OAuth sign-ins by server name. */
    signIns: ReadonlyMap<string, MCPServerSignIn>;
    statuses: Record<string, ServerStatusInfo>;
}

export const MCPServerList: FC<MCPServerListProps> = ({
    editingIndex,
    onDelete,
    onEdit,
    onSignIn,
    onSignOut,
    onTest,
    onToggle,
    servers,
    signingIn,
    signIns,
    statuses,
}) => {
    const { t } = useLingui();

    if (servers.length === 0) {
        return <div className="text-muted-foreground py-8 text-center text-sm">{t`No MCP servers configured. Add a server to extend AI capabilities.`}</div>;
    }

    return (
        <div className="space-y-2">
            {servers.map((server, index) => {
                const key = serverKey(server);
                const statusInfo = statuses[key];
                const isTesting = statusInfo?.status === "connecting";
                // A sign-in is only this server's when the url still matches.
                const signIn = signIns.get(server.name);
                const ownSignIn = signIn && signIn.serverUrl === server.url ? signIn : undefined;
                const isSignedIn = ownSignIn?.status === "connected";
                const offerSignIn = !isSignedIn && (statusInfo?.requiresOAuth === true || ownSignIn !== undefined);

                return (
                    <div
                        className={cn(
                            "rounded-lg border p-3 transition-colors",
                            !server.enabled && "opacity-60",
                            editingIndex === index && "ring-primary ring-2",
                        )}
                        key={key}
                    >
                        <div className="flex items-center justify-between">
                            <button
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 bg-transparent text-left"
                                onClick={() => onEdit(index)}
                                type="button"
                            >
                                <Avatar className="size-7 shrink-0" size="sm">
                                    {(server.icon || getServerFaviconUrl(server.url)) && <AvatarImage src={server.icon || getServerFaviconUrl(server.url)} />}
                                    <AvatarFallback>{getServerInitials(server.name)}</AvatarFallback>
                                </Avatar>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-sm font-medium">{server.name}</span>
                                        <Badge className="px-1.5 py-0 text-[10px]" variant="outline">
                                            {server.protocol.toUpperCase()}
                                        </Badge>
                                        {statusInfo && <StatusIndicator info={statusInfo} />}
                                        {isSignedIn && (
                                            <Badge className="px-1.5 py-0 text-[10px]" variant="secondary">
                                                {ownSignIn.accountLabel ? t`Signed in · ${ownSignIn.accountLabel}` : t`Signed in`}
                                            </Badge>
                                        )}
                                        {ownSignIn && !isSignedIn && (
                                            <Badge className="px-1.5 py-0 text-[10px]" variant="destructive">
                                                {t`Sign-in expired`}
                                            </Badge>
                                        )}
                                    </div>
                                    <p className="text-muted-foreground truncate text-xs">{server.url}</p>
                                    {server.headers && server.headers.length > 0 && (
                                        <p className="text-muted-foreground text-xs">
                                            {t`${server.headers.length} custom headers`}
                                            {server.headers.some((h) => isSensitiveKey(h.key))
                                                ? ` \u{B7} ${server.headers.flatMap((h) => (isSensitiveKey(h.key) ? [`${h.key}: ${maskValue(h.value)}`] : [])).join(", ")}`
                                                : ""}
                                        </p>
                                    )}
                                </div>
                            </button>
                            <div className="flex items-center gap-1">
                                {offerSignIn && (
                                    <Button
                                        aria-busy={signingIn === server.name}
                                        disabled={signingIn === server.name}
                                        onClick={() => onSignIn(server)}
                                        size="sm"
                                        variant="outline"
                                    >
                                        {signingIn === server.name ? (
                                            <Loader2 aria-hidden="true" className="mr-1 size-3.5 animate-spin" />
                                        ) : (
                                            <KeyRound aria-hidden="true" className="mr-1 size-3.5" />
                                        )}
                                        {t`Sign in`}
                                        <span className="sr-only">{t`to ${server.name}`}</span>
                                    </Button>
                                )}
                                {ownSignIn && (
                                    <Button
                                        aria-label={t`Sign out of ${server.name}`}
                                        className="size-8 p-0"
                                        onClick={() => onSignOut(server)}
                                        size="sm"
                                        variant="ghost"
                                    >
                                        <LogOut aria-hidden="true" className="size-3.5" />
                                    </Button>
                                )}
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger
                                            render={
                                                <Button
                                                    aria-label={t`Test connection`}
                                                    className="size-8 p-0"
                                                    disabled={isTesting}
                                                    onClick={() => onTest(server)}
                                                    size="sm"
                                                    variant="ghost"
                                                >
                                                    {isTesting ? (
                                                        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                                                    ) : (
                                                        <PlugZap aria-hidden="true" className="size-3.5" />
                                                    )}
                                                </Button>
                                            }
                                        />
                                        <TooltipContent side="top">{t`Test connection`}</TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                                <Switch
                                    aria-label={t`Toggle ${server.name}`}
                                    checked={server.enabled}
                                    onCheckedChange={(checked) => onToggle(index, checked)}
                                />
                                <Button
                                    aria-label={t`Delete ${server.name}`}
                                    className="text-destructive hover:text-destructive size-8 p-0"
                                    onClick={() => onDelete(index)}
                                    size="sm"
                                    variant="ghost"
                                >
                                    <Trash2 aria-hidden="true" className="size-4" />
                                </Button>
                            </div>
                        </div>

                        {/* Tool chips — show when we have test results */}
                        {statusInfo?.status === "connected" && statusInfo.tools.length > 0 && <ToolChips tools={statusInfo.tools} />}
                    </div>
                );
            })}
        </div>
    );
};
