"use client";

/**
 * Tool Permissions settings — one Auto / Ask / Off control per tool, grouped by
 * source (built-in categories, then each MCP server).
 *
 * Built-ins come from a query; MCP tools need a live connection to enumerate, so
 * they come from an action and load separately. Overrides are written one key at
 * a time (`setToolPermission`), and "Reset" removes the override so the tool
 * falls back to its default.
 */

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Alert, AlertDescription } from "@neore/ui/components/alert";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Heading, HeadingSection } from "@neore/ui/components/heading";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import type { FC } from "react";
import { useId } from "react";

import { useAction, useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

type Mode = "ask" | "auto" | "off";

const MODES: ReadonlyArray<Mode> = ["auto", "ask", "off"];

const isMode = (value: unknown): value is Mode => typeof value === "string" && (MODES as ReadonlyArray<string>).includes(value);

interface ToolRowData {
    available: boolean;
    defaultMode: Mode;
    description?: string;
    destructive?: boolean;
    key: string;
    name: string;
    readOnly?: boolean;
}

interface ToolRowProps {
    isSaving: boolean;
    onChange: (key: string, mode: Mode | null) => void;
    override: Mode | undefined;
    tool: ToolRowData;
}

const ToolRow: FC<ToolRowProps> = ({ isSaving, onChange, override, tool }) => {
    const { t } = useLingui();
    const nameId = useId();
    const effective = override ?? tool.defaultMode;
    const modeLabels: Record<Mode, string> = { ask: t`Ask`, auto: t`Auto`, off: t`Off` };

    return (
        <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm" id={nameId}>
                        {tool.name}
                    </span>
                    {tool.readOnly && <Badge variant="secondary">{t`read-only`}</Badge>}
                    {tool.destructive && <Badge variant="destructive">{t`destructive`}</Badge>}
                    {!tool.available && <Badge variant="outline">{t`not configured`}</Badge>}
                </div>
                {tool.description && <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{tool.description}</p>}
                <p className="text-muted-foreground mt-0.5 text-xs">{override ? t`Custom setting (default: ${modeLabels[tool.defaultMode]})` : t`Default`}</p>
            </div>
            <div className="flex items-center gap-2">
                <ToggleGroup
                    aria-labelledby={nameId}
                    disabled={isSaving}
                    onValueChange={(value) => {
                        const next = value?.[0];

                        if (isMode(next) && next !== effective) {
                            onChange(tool.key, next);
                        }
                    }}
                    size="sm"
                    value={[effective]}
                    variant="outline"
                >
                    {MODES.map((mode) => (
                        <ToggleGroupItem aria-label={t`${modeLabels[mode]} for ${tool.name}`} key={mode} value={mode}>
                            {modeLabels[mode]}
                        </ToggleGroupItem>
                    ))}
                </ToggleGroup>
                {override && (
                    <Button
                        aria-label={t`Reset ${tool.name} to default`}
                        disabled={isSaving}
                        onClick={() => onChange(tool.key, null)}
                        size="sm"
                        variant="ghost"
                    >
                        {t`Reset`}
                    </Button>
                )}
            </div>
        </li>
    );
};

interface ToolGroupProps {
    description?: string;
    error?: string | null;
    isSaving: boolean;
    onChange: (key: string, mode: Mode | null) => void;
    overrides: Record<string, Mode>;
    title: string;
    tools: ToolRowData[];
}

const ToolGroup: FC<ToolGroupProps> = ({ description, error, isSaving, onChange, overrides, title, tools }) => {
    const { t } = useLingui();

    return (
        <Card>
            <CardHeader>
                <CardTitle>{title}</CardTitle>
                {description && <CardDescription>{description}</CardDescription>}
            </CardHeader>
            <CardContent>
                {error && (
                    <p className="text-destructive text-sm" role="alert">
                        {t`Could not load tools: ${error}`}
                    </p>
                )}
                {!error && tools.length === 0 && <p className="text-muted-foreground text-sm">{t`No tools.`}</p>}
                <ul className="divide-y">
                    {tools.map((tool) => (
                        <ToolRow isSaving={isSaving} key={tool.key} onChange={onChange} override={overrides[tool.key]} tool={tool} />
                    ))}
                </ul>
            </CardContent>
        </Card>
    );
};

const ToolPermissionsSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const settingsOptions = crpc.chat.tool_permissions.getToolPermissionSettings.queryOptions({});
    const { data: settings, isLoading } = useQuery(settingsOptions);

    const listMcpTools = useAction(api.chat.tool_permissions.listMcpToolPermissions);
    const { data: mcpData, isLoading: isMcpLoading } = useQuery({
        queryFn: () => listMcpTools({}),
        queryKey: ["tool-permissions-mcp"],
        retry: 1,
        staleTime: 5 * 60 * 1000,
    });

    const { isPending: isSaving, mutate: setToolPermission } = useMutation(crpc.chat.tool_permissions.setToolPermission.mutationOptions());

    if (isLoading) {
        return (
            <div className="text-muted-foreground text-sm" role="status">
                {t`Loading...`}
            </div>
        );
    }

    const handleChange = (key: string, mode: Mode | null) => {
        setToolPermission(
            { key, mode },
            {
                onError: (error) => showError(error instanceof Error ? error : t`Failed to update tool permission`),
                onSettled: () => {
                    void queryClient.invalidateQueries({ queryKey: settingsOptions.queryKey });
                },
            },
        );
    };

    const overrides: Record<string, Mode> = {};

    const storedOverrides = Object.entries(settings?.overrides ?? {});

    for (const [key, value] of storedOverrides) {
        if (isMode(value)) {
            overrides[key] = value;
        }
    }

    const builtInByCategory = new Map<string, ToolRowData[]>();

    const builtInTools = settings?.builtIn ?? [];

    for (const tool of builtInTools) {
        const list = builtInByCategory.get(tool.category) ?? [];

        list.push({ available: tool.available, defaultMode: tool.defaultMode, key: tool.key, name: tool.name });
        builtInByCategory.set(tool.category, list);
    }

    return (
        <div className="space-y-6">
            <div>
                <Heading className="text-2xl font-bold tracking-tight">{t`Tool Permissions`}</Heading>
                <p className="text-muted-foreground">{t`Choose which tools the assistant may use on its own, which need your approval, and which are off.`}</p>
            </div>

            <Alert>
                <Info aria-hidden="true" className="h-4 w-4" />
                <AlertDescription>
                    {t`Auto: runs without asking. Ask: pauses for your Approve / Deny. Off: the assistant never sees the tool. Automations (triggers, messenger bots, workflows) cannot ask, so "Ask" tools are unavailable there. MCP tools default to Ask unless the server marks them read-only.`}
                </AlertDescription>
            </Alert>

            <HeadingSection>
                <section aria-label={t`Built-in tools`} className="space-y-4">
                    <Heading className="text-lg font-semibold" fallbackLevel={3}>{t`Built-in tools`}</Heading>
                    <HeadingSection>
                        {[...builtInByCategory].map(([category, tools]) => (
                            <ToolGroup isSaving={isSaving} key={category} onChange={handleChange} overrides={overrides} title={category} tools={tools} />
                        ))}
                    </HeadingSection>
                </section>

                <section aria-label={t`MCP tools`} className="space-y-4">
                    <Heading className="text-lg font-semibold" fallbackLevel={3}>{t`MCP tools`}</Heading>
                    <HeadingSection>
                        {isMcpLoading && (
                            <p className="text-muted-foreground text-sm" role="status">
                                {t`Connecting to your MCP servers...`}
                            </p>
                        )}
                        {!isMcpLoading && (mcpData?.servers.length ?? 0) === 0 && <p className="text-muted-foreground text-sm">{t`No enabled MCP servers.`}</p>}
                        {mcpData?.servers.map((server) => (
                            <ToolGroup
                                description={t`MCP server`}
                                error={server.error}
                                isSaving={isSaving}
                                key={server.name}
                                onChange={handleChange}
                                overrides={overrides}
                                title={server.name}
                                tools={server.tools.map((tool) => {
                                    return { ...tool, available: true };
                                })}
                            />
                        ))}
                    </HeadingSection>
                </section>
            </HeadingSection>
        </div>
    );
};

export default ToolPermissionsSettings;
