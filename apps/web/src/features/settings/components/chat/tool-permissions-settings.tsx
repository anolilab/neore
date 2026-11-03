"use client";

/**
 * Tool Permissions settings — one Auto / Ask / Off control per tool, grouped by
 * source (built-in categories, then each MCP server).
 *
 * Built-ins come from a query; MCP tools need a live connection to enumerate, so
 * they come from an action and load separately. Overrides are written one key at
 * a time (`setToolPermission`), and "Reset" removes the override so the tool
 * falls back to its default. Tools allowed for an hour or for today
 * (`respondToToolApproval`) are listed with their expiry and can be revoked early.
 */

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Alert, AlertDescription } from "@neore/ui/components/alert";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Heading, HeadingSection } from "@neore/ui/components/heading";
import { Label } from "@neore/ui/components/label";
import { Switch } from "@neore/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useState } from "react";

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
    /** A time-boxed allow is running for this tool: choosing its current mode must still end it. */
    hasGrant: boolean;
    isSaving: boolean;
    onChange: (key: string, mode: Mode | null) => void;
    override: Mode | undefined;
    tool: ToolRowData;
}

const ToolRow: FC<ToolRowProps> = ({ hasGrant, isSaving, onChange, override, tool }) => {
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
                        // Clicking the pressed mode clears the group's value; with an allow running it is still a choice.
                        const next = value?.[0] ?? (hasGrant ? effective : undefined);

                        if (isMode(next) && (next !== effective || hasGrant)) {
                            // Choosing the default again resets rather than pinning it as a custom setting.
                            onChange(tool.key, override === undefined && next === tool.defaultMode ? null : next);
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
    grants: Record<string, number>;
    isSaving: boolean;
    onChange: (key: string, mode: Mode | null) => void;
    overrides: Record<string, Mode>;
    title: string;
    tools: ToolRowData[];
}

const ToolGroup: FC<ToolGroupProps> = ({ description, error, grants, isSaving, onChange, overrides, title, tools }) => {
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
                        <ToolRow
                            hasGrant={grants[tool.key] !== undefined}
                            isSaving={isSaving}
                            key={tool.key}
                            onChange={onChange}
                            override={overrides[tool.key]}
                            tool={tool}
                        />
                    ))}
                </ul>
            </CardContent>
        </Card>
    );
};

/** `mcp:<server>:<tool>` / `connector:<slug>:<tool>` / `builtin:<tool>` to a name a person reads. */
const describeGrantKey = (key: string): { server?: string; tool: string } => {
    const [source, ...rest] = key.split(":");
    const tool = rest.at(-1) ?? key;

    return source === "builtin" || rest.length < 2 ? { tool } : { server: rest.slice(0, -1).join(":"), tool };
};

interface TimedAllowsProps {
    grants: Record<string, number>;
    isRevoking: boolean;
    onRevoke: (key: string) => void;
}

const TimedAllows: FC<TimedAllowsProps> = ({ grants, isRevoking, onRevoke }) => {
    const { i18n, t } = useLingui();
    // Ticks so an allow that lapses while the page is open drops off the list.
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);

        return () => clearInterval(timer);
    }, []);

    const active = Object.entries(grants)
        .filter(([, expiresAt]) => expiresAt > now)
        .toSorted(([, a], [, b]) => a - b);

    if (active.length === 0) {
        return null;
    }

    return (
        <section aria-label={t`Allowed for a limited time`} className="space-y-2">
            <Heading className="text-lg font-semibold" fallbackLevel={3}>{t`Allowed for a limited time`}</Heading>
            <p className="text-muted-foreground text-sm">{t`These tools run without asking until the time shown. Revoke one to be asked again from your next message.`}</p>
            <ul className="divide-y rounded-lg border px-4">
                {active.map(([key, expiresAt]) => {
                    const { server, tool } = describeGrantKey(key);
                    const until = i18n.date(new Date(expiresAt), { dateStyle: "short", timeStyle: "short" });

                    return (
                        <li className="flex items-center justify-between gap-2 py-3" key={key}>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{tool}</p>
                                <p className="text-muted-foreground truncate text-xs">{server ? t`${server} · until ${until}` : t`Until ${until}`}</p>
                            </div>
                            <Button
                                aria-label={server ? t`Revoke the allow for ${tool} on ${server}` : t`Revoke the allow for ${tool}`}
                                disabled={isRevoking}
                                onClick={() => onRevoke(key)}
                                size="sm"
                                variant="outline"
                            >
                                {t`Revoke`}
                            </Button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
};

interface QuickCheckProps {
    checked: boolean;
    isSaving: boolean;
    onChange: (enabled: boolean) => void;
}

/** The opt-in quick check for low-risk calls. Says what it covers and what it never does, since it replaces a click. */
const QuickCheckSetting: FC<QuickCheckProps> = ({ checked, isSaving, onChange }) => {
    const { t } = useLingui();
    const switchId = useId();
    const detailsId = useId();

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                        <CardTitle>
                            <Label htmlFor={switchId}>{t`Let a quick check approve low-risk calls`}</Label>
                        </CardTitle>
                        <CardDescription id={detailsId}>
                            {t`Before a connected tool set to Ask pauses the chat, a short model check reads the call. It only looks at tools from MCP servers and connectors you have marked as trusted, and only those whose name starts with a read verb such as get, list, search or fetch, and never after the chat has read your knowledge base, memories, project context, a tool result, an attached file, document or web page, or while any skill is enabled. If it judges the call low risk, the call runs and the chat notes that it was approved automatically, with the reason. Everything else still asks you. Off by default.`}
                        </CardDescription>
                    </div>
                    <Switch aria-describedby={detailsId} checked={checked} disabled={isSaving} id={switchId} onCheckedChange={onChange} />
                </div>
            </CardHeader>
            <CardContent>
                <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
                    <li>{t`Covers only tools from MCP servers and connectors you trust for auto-approval (a switch on each server in your MCP settings and on each connector), left at their default Ask, in chats only you can write to. A trusted server's tool descriptions reach the model and can influence what is approved, so trust only servers you would let act for you. Changing a server's address ends its trust.`}</li>
                    <li>{t`Never covers a tool you set to Ask yourself, built-in tools, device tools, questions to you, sub-agents or coding agents, or anything that sends, publishes, pays or deletes.`}</li>
                    <li>{t`Never covers a call after the chat has read web pages, attached files, documents or pages, knowledge or other tool results: those can carry hidden instructions.`}</li>
                    <li>{t`Never covers a call while any skill is enabled or invoked. Skills can come from the marketplace, an organization or an import, and there is no reliable way to tell yours apart, so switch your skills off to use the quick check.`}</li>
                    <li>{t`Each check is one small model call on your account and is rate-limited. If it fails or runs out of time, you are asked as usual.`}</li>
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

    const { isPending: isSavingQuickCheck, mutate: setQuickCheck } = useMutation(crpc.chat.tool_permissions.setAutoApproveLowRisk.mutationOptions());

    const { isPending: isRevoking, mutate: revokeGrant } = useMutation(crpc.chat.tool_permissions.revokeToolPermissionGrant.mutationOptions());

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

    const handleQuickCheck = (enabled: boolean) => {
        setQuickCheck(
            { enabled },
            {
                onError: (error) => showError(error instanceof Error ? error : t`Failed to update the quick check`),
                onSettled: () => {
                    void queryClient.invalidateQueries({ queryKey: settingsOptions.queryKey });
                },
            },
        );
    };

    const handleRevoke = (key: string) => {
        revokeGrant(
            { key },
            {
                onError: (error) => showError(error instanceof Error ? error : t`Failed to revoke the allow`),
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

            <QuickCheckSetting checked={settings?.autoApproveLowRisk === true} isSaving={isSavingQuickCheck} onChange={handleQuickCheck} />

            <TimedAllows grants={settings?.grants ?? {}} isRevoking={isRevoking} onRevoke={handleRevoke} />

            <HeadingSection>
                <section aria-label={t`Built-in tools`} className="space-y-4">
                    <Heading className="text-lg font-semibold" fallbackLevel={3}>{t`Built-in tools`}</Heading>
                    <HeadingSection>
                        {[...builtInByCategory].map(([category, tools]) => (
                            <ToolGroup
                                grants={settings?.grants ?? {}}
                                isSaving={isSaving}
                                key={category}
                                onChange={handleChange}
                                overrides={overrides}
                                title={category}
                                tools={tools}
                            />
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
                                grants={settings?.grants ?? {}}
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
