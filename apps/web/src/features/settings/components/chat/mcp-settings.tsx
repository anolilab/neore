"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Separator } from "@neore/ui/components/separator";
import MCPIcon from "@neore/ui/icons/mcp";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, Plus } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useAction, useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";

import { consumeMcpInstallRequests } from "./mcp/pending-install";
import { MCPServerCatalog } from "./mcp/server-catalog";
import { MCPServerForm } from "./mcp/server-form";
import { MCPServerList } from "./mcp/server-list";
import type { CatalogServer, MCPHeader, MCPProtocol, MCPServerConfig, MCPServerFormData, ServerStatusInfo } from "./mcp/types";
import { catalogServerToFormData, EMPTY_SERVER, findMissingSetupField, hasUnresolvedPlaceholder, isValidUrl, serverKey } from "./mcp/utilities";

interface MCPTestResult {
    error?: string;
    latencyMs: number;
    ok: boolean;
    requiresOAuth?: boolean;
    tools: string[];
}

const MCPSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: aiPreferences } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const { mutateAsync: updateAIUserPreferences } = useMutation(crpc.auth.functions.updateAIUserPreferences.mutationOptions());
    const testMCPAction = useAction(api.chat.functions.testMCPServerConnection);
    const testConnectionMutation = useMutation({ mutationFn: testMCPAction });
    const { mutateAsync: testConnection } = testConnectionMutation;
    const { data: signIns } = useQuery(crpc.connectors.mcp_servers.listMcpServerSignIns.queryOptions({}));
    const {
        isPending: isStartingSignIn,
        mutateAsync: startSignIn,
        variables: signInVariables,
    } = useMutation(useLunoraActionOptions(api.connectors.mcp_servers.startMcpServerOAuth));
    const { mutateAsync: signOut } = useMutation(useLunoraActionOptions(api.connectors.mcp_servers.signOutMcpServer));
    const queryClient = useQueryClient();

    const [isAdding, setIsAdding] = useState(false);
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [formData, setFormData] = useState<MCPServerFormData>(EMPTY_SERVER);

    // A server the skill Agent Builder handed over opens the add form prefilled;
    // the user still reviews and saves it like any catalogue install.
    useEffect(
        () =>
            consumeMcpInstallRequests((server) => {
                setEditingIndex(null);
                setFormData(catalogServerToFormData(server));
                setIsAdding(true);
            }),
        [],
    );

    // Connection status per server (keyed by "name::url" for stability)
    const [serverStatuses, setServerStatuses] = useState<Record<string, ServerStatusInfo>>({});

    // Memoised: a fresh `[]` every render invalidated every callback below.
    const servers: MCPServerConfig[] = useMemo(() => aiPreferences?.mcpServers ?? [], [aiPreferences?.mcpServers]);
    const configuredUrls = useMemo(() => new Set(servers.map((s) => s.url)), [servers]);

    // ── OAuth sign-in ──────────────────────────────────────────────────────

    const signInsByName = useMemo(() => new Map((signIns ?? []).map((signIn) => [signIn.serverName, signIn])), [signIns]);

    // A server whose sign-in lives on another site waits here for the user to trust it.
    const [pendingTrust, setPendingTrust] = useState<{ authorizationServerHosts: string[]; mcpServerHost: string; server: MCPServerConfig } | null>(null);

    const beginSignIn = useCallback(
        async (server: MCPServerConfig, trustAuthorizationServerHosts?: string[]) => {
            try {
                const started = await startSignIn({ serverName: server.name, ...(trustAuthorizationServerHosts && { trustAuthorizationServerHosts }) });

                if (started.kind === "confirm") {
                    setPendingTrust({ authorizationServerHosts: started.authorizationServerHosts, mcpServerHost: started.mcpServerHost, server });

                    return;
                }

                // The server's consent screen, which returns to /dashboard/settings/connectors/callback.
                globalThis.location.assign(started.url);
            } catch (error) {
                toast.error(error instanceof Error && error.message ? error.message : t`Could not start sign-in`);
            }
        },
        [startSignIn, t],
    );

    const handleSignIn = useCallback(
        (server: MCPServerConfig) => {
            beginSignIn(server).catch(() => undefined);
        },
        [beginSignIn],
    );

    const handleTrustConfirmed = useCallback(() => {
        if (!pendingTrust) {
            return;
        }

        setPendingTrust(null);
        beginSignIn(pendingTrust.server, pendingTrust.authorizationServerHosts).catch(() => undefined);
    }, [beginSignIn, pendingTrust]);

    const trustHosts = pendingTrust?.authorizationServerHosts.join(", ") ?? "";

    /** Best-effort: the grant is revoked at the server and forgotten here. Quiet unless asked for. */
    const revokeSignIn = useCallback(
        async (serverName: string, announce: boolean) => {
            if (!signInsByName.has(serverName)) {
                return;
            }

            try {
                await signOut({ serverName });
                await queryClient.invalidateQueries({ queryKey: crpc.connectors.mcp_servers.listMcpServerSignIns.queryKey({}) });

                if (announce) {
                    toast.success(t`Signed out of ${serverName}`);
                }
            } catch (error) {
                if (announce) {
                    toast.error(error instanceof Error && error.message ? error.message : t`Could not sign out`);
                }
            }
        },
        [crpc, queryClient, signInsByName, signOut, t],
    );

    const handleSignOut = useCallback(
        (server: MCPServerConfig) => {
            revokeSignIn(server.name, true).catch(() => undefined);
        },
        [revokeSignIn],
    );

    // ── Form handlers ──────────────────────────────────────────────────────

    const resetForm = useCallback(() => {
        setFormData(EMPTY_SERVER);
        setIsAdding(false);
        setEditingIndex(null);
    }, []);

    const handleSave = useCallback(async () => {
        if (!formData.name.trim()) {
            toast.error(t`Server name is required`);

            return;
        }

        const missingField = findMissingSetupField(formData);

        if (missingField) {
            toast.error(t`${missingField.label} is required`);

            return;
        }

        if (!formData.url.trim()) {
            toast.error(t`Server URL is required`);

            return;
        }

        if (!isValidUrl(formData.url) || (formData.setup && hasUnresolvedPlaceholder(formData.url))) {
            toast.error(t`Invalid URL format`);

            return;
        }

        const iconTrimmed = formData.icon.trim();

        if (iconTrimmed && !isValidUrl(iconTrimmed)) {
            toast.error(t`Invalid icon URL format`);

            return;
        }

        const cleanHeaders = formData.headers.filter((h) => h.key.trim() && h.value.trim());

        // `setup` is install-time UI state and is deliberately not persisted.
        const serverData = {
            enabled: formData.enabled,
            headers: cleanHeaders.length > 0 ? cleanHeaders : undefined,
            icon: iconTrimmed || undefined,
            name: formData.name.trim(),
            protocol: formData.protocol,
            url: formData.url.trim(),
        };

        try {
            const previous = editingIndex === null ? undefined : servers[editingIndex];

            // A sign-in belongs to a name AND url; re-pointing the server ends it.
            if (previous && (previous.name !== serverData.name || previous.url !== serverData.url)) {
                await revokeSignIn(previous.name, false);
            }

            const updatedServers = [...servers];

            if (editingIndex === null) {
                updatedServers.push(serverData);
            } else {
                updatedServers[editingIndex] = serverData;
            }

            await updateAIUserPreferences({
                mcpServers: updatedServers,
            });

            toast.success(editingIndex === null ? t`MCP server added` : t`MCP server updated`);
            resetForm();
        } catch (error) {
            toast.error(t`Failed to save MCP server`);
            console.error(error);
        }
    }, [formData, servers, editingIndex, updateAIUserPreferences, resetForm, revokeSignIn, t]);

    const handleDelete = useCallback(
        async (index: number) => {
            try {
                const removed = servers[index];

                // A removed server must not keep its third-party access alive.
                if (removed) {
                    await revokeSignIn(removed.name, false);
                }

                const updatedServers = servers.filter((_, i) => i !== index);

                await updateAIUserPreferences({
                    mcpServers: updatedServers.length > 0 ? updatedServers : undefined,
                });

                toast.success(t`MCP server removed`);

                if (editingIndex === index) {
                    resetForm();
                }
            } catch (error) {
                toast.error(t`Failed to remove MCP server`);
                console.error(error);
            }
        },
        [servers, editingIndex, updateAIUserPreferences, resetForm, revokeSignIn, t],
    );

    const handleToggle = useCallback(
        async (index: number, enabled: boolean) => {
            try {
                const updatedServers = servers.map((s, i) => (i === index ? { ...s, enabled } : s));

                await updateAIUserPreferences({
                    mcpServers: updatedServers,
                });

                toast.success(enabled ? t`MCP server enabled` : t`MCP server disabled`);
            } catch (error) {
                toast.error(t`Failed to update MCP server`);
                console.error(error);
            }
        },
        [servers, updateAIUserPreferences, t],
    );

    const handleEdit = useCallback(
        (index: number) => {
            const server = servers[index];

            if (!server) {
                return;
            }

            setFormData({
                enabled: server.enabled,
                headers: server.headers ?? [],
                icon: server.icon ?? "",
                name: server.name,
                protocol: server.protocol,
                url: server.url,
            });
            setEditingIndex(index);
            setIsAdding(true);
        },
        [servers],
    );

    const handleInstall = useCallback((server: CatalogServer) => {
        setFormData(catalogServerToFormData(server));
        setEditingIndex(null);
        setIsAdding(true);
    }, []);

    // ── Test connection ────────────────────────────────────────────────────

    const handleTestConnection = useCallback(
        async (config?: { headers?: MCPHeader[]; name: string; protocol: MCPProtocol; url: string }) => {
            const target = config ?? formData;

            if (!target.url.trim()) {
                toast.error(t`Server URL is required to test connection`);

                return;
            }

            if (!isValidUrl(target.url) || hasUnresolvedPlaceholder(target.url)) {
                toast.error(t`Invalid URL format`);

                return;
            }

            const key = serverKey({ name: target.name || "test", url: target.url });

            setServerStatuses((previous) => {
                return {
                    ...previous,
                    [key]: { status: "connecting", tools: [] },
                };
            });

            try {
                const cleanHeaders = (target.headers ?? []).filter((h) => h.key.trim() && h.value.trim());

                const result: MCPTestResult = await testConnection({
                    headers: cleanHeaders.length > 0 ? cleanHeaders : undefined,
                    name: target.name || "test",
                    protocol: target.protocol,
                    url: target.url.trim(),
                });

                if (result.ok) {
                    setServerStatuses((previous) => {
                        return {
                            ...previous,
                            [key]: {
                                latencyMs: result.latencyMs,
                                status: "connected",
                                tools: result.tools,
                            },
                        };
                    });
                    toast.success(t`Connected — ${result.tools.length} tools found (${result.latencyMs}ms)`);
                } else {
                    setServerStatuses((previous) => {
                        return {
                            ...previous,
                            [key]: {
                                error: result.error,
                                ...(result.requiresOAuth && { requiresOAuth: true }),
                                status: "error",
                                tools: [],
                            },
                        };
                    });
                    toast.error(result.requiresOAuth ? t`This server requires sign-in. Save it, then choose Sign in.` : result.error || t`Connection failed`);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : t`Connection test failed`;

                setServerStatuses((previous) => {
                    return {
                        ...previous,
                        [key]: { error: message, status: "error", tools: [] },
                    };
                });
                toast.error(message);
            }
        },
        [formData, testConnection, t],
    );

    const handleTestExistingServer = useCallback(
        (server: MCPServerConfig) => {
            handleTestConnection({
                headers: server.headers,
                name: server.name,
                protocol: server.protocol,
                url: server.url,
            });
        },
        [handleTestConnection],
    );

    // ── Render ─────────────────────────────────────────────────────────────

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <MCPIcon aria-hidden="true" className="size-5" />
                            <div>
                                <CardTitle className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{t`MCP Servers`}</CardTitle>
                                <CardDescription className="text-muted-foreground mt-1 text-xs">
                                    {t`Connect to Model Context Protocol servers to extend AI capabilities with external tools.`}
                                </CardDescription>
                            </div>
                        </div>
                        {!isAdding && (
                            <Button onClick={() => setIsAdding(true)} size="sm" variant="outline">
                                <Plus aria-hidden="true" className="mr-2 size-4" />
                                {t`Add Server`}
                            </Button>
                        )}
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Info banner */}
                    <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300">
                        <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                        <div>
                            <p>
                                {t`MCP servers provide additional tools that the AI can use during conversations. Tools from connected servers are automatically available when chatting.`}
                            </p>
                            <a
                                className="mt-1 inline-flex items-center gap-1 text-blue-600 underline dark:text-blue-400"
                                href="https://modelcontextprotocol.io/introduction"
                                rel="noopener noreferrer"
                                target="_blank"
                            >
                                {t`Learn more about MCP`}
                                <ExternalLink aria-hidden="true" className="size-3" />
                            </a>
                        </div>
                    </div>

                    {isAdding && (
                        <>
                            <MCPServerForm
                                formData={formData}
                                isEditing={editingIndex !== null}
                                isTesting={testConnectionMutation.isPending}
                                onCancel={resetForm}
                                onSave={handleSave}
                                onTest={() => handleTestConnection()}
                                setFormData={setFormData}
                                testResult={serverStatuses[serverKey({ name: formData.name || "test", url: formData.url })]}
                            />
                            <Separator />
                        </>
                    )}

                    <MCPServerList
                        editingIndex={editingIndex}
                        onDelete={handleDelete}
                        onEdit={handleEdit}
                        onSignIn={handleSignIn}
                        onSignOut={handleSignOut}
                        onTest={handleTestExistingServer}
                        onToggle={handleToggle}
                        servers={servers}
                        signingIn={isStartingSignIn ? signInVariables?.serverName : undefined}
                        signIns={signInsByName}
                        statuses={serverStatuses}
                    />
                </CardContent>
            </Card>

            <MCPServerCatalog configuredUrls={configuredUrls} disabled={isAdding} onInstall={handleInstall} />

            <ConfirmDialog
                confirmLabel={t`I trust this server`}
                description={t`${pendingTrust?.server.name ?? ""} (${pendingTrust?.mcpServerHost ?? ""}) asks you to sign in at ${trustHosts}, which is a different site. The access you grant there will be sent to ${pendingTrust?.mcpServerHost ?? ""}. Continue only if you trust this server with that account.`}
                loading={isStartingSignIn}
                onConfirm={handleTrustConfirmed}
                onOpenChange={(open) => {
                    if (!open) {
                        setPendingTrust(null);
                    }
                }}
                open={pendingTrust !== null}
                title={t`Sign in on another site?`}
            />
        </div>
    );
};

export default MCPSettings;
