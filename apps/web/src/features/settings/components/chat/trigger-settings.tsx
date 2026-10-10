"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardHeading, CardTitle } from "@neore/ui/components/card";
import { Heading, HeadingSection } from "@neore/ui/components/heading";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Separator } from "@neore/ui/components/separator";
import { Switch } from "@neore/ui/components/switch";
import { Textarea } from "@neore/ui/components/textarea";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import {
    AlertTriangle,
    Calendar,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Clock,
    Copy,
    ExternalLink,
    Globe,
    Loader2,
    Pencil,
    Play,
    Plus,
    Trash2,
    XCircle,
    Zap,
} from "lucide-react";
import type { FC } from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import env from "@/lib/env";
import { useAction, useCRPC } from "@/lib/lunora/crpc";

/** The template variable a webhook trigger fills with the request body; code, not copy. */
const PAYLOAD_TOKEN = "{{payload}}";

// ─── Types ─────────────────────────────────────────────────────────────────

type TriggerType = "event" | "schedule" | "webhook";

interface TriggerFormData {
    cronExpression: string;
    description: string;
    inputTemplate: string;
    model: string;
    name: string;
    systemPrompt: string;
    timezone: string;
    type: TriggerType;
}

/**
 * A row of `triggers_functions.getTriggers` / `.getTriggerExecutions`.
 *
 * These mirror the generated return types in `@neore/backend/api`, with one
 * deliberate difference: codegen types `_id` as a bare `string`, losing the
 * `Id&lt;"triggers">` brand that every mutation on this screen requires. The list
 * is asserted to `TriggerRow[]` once, at the `.map` below, to put the brand back.
 *
 * `TriggerExecutionRow` is declared rather than derived because the `crpc` shim
 * still widens the executions query's return type to `{}`.
 */
interface TriggerRow {
    _creationTime: number;
    _id: Id<"triggers">;
    createdAt: number;
    cronExpression: string | null;
    description: string | null;
    enabled: boolean;
    inputTemplate: string | null;
    lastError: string | null;
    lastTriggeredAt: number | null;
    model: string;
    name: string;
    nextTriggerAt: number | null;
    searchMode: string | null;
    systemPrompt: string | null;
    timezone: string | null;
    triggerCount: number;
    type: string;
    updatedAt: number;
}

interface TriggerExecutionRow {
    _id: string;
    completedAt: number | null;
    error: string | null;
    startedAt: number;
    status: string;
    threadId: string | null;
}

const EMPTY_FORM: TriggerFormData = {
    cronExpression: "0 8 * * *",
    description: "",
    inputTemplate: "",
    model: "",
    name: "",
    systemPrompt: "",
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    type: "schedule",
};

const CRON_PRESETS: { expression: string; label: MessageDescriptor }[] = [
    { expression: "0 8 * * *", label: msg`Every day at 8 AM` },
    { expression: "0 8 * * 1-5", label: msg`Weekdays at 8 AM` },
    { expression: "0 */6 * * *", label: msg`Every 6 hours` },
    { expression: "0 0 * * 0", label: msg`Every Sunday at midnight` },
    { expression: "0 9 1 * *", label: msg`First of each month at 9 AM` },
];

const TRIGGER_TYPE_LABELS: Record<TriggerType, MessageDescriptor> = {
    event: msg`Event`,
    schedule: msg`Schedule`,
    webhook: msg`Webhook`,
};

const EXECUTION_STATUS_LABELS: Partial<Record<string, MessageDescriptor>> = {
    completed: msg`Completed`,
    failed: msg`Failed`,
    pending: msg`Pending`,
    running: msg`Running`,
};

// ─── Component ─────────────────────────────────────────────────────────────

// ─── Shared Trigger Form ────────────────────────────────────────────────────

interface TriggerFormProps {
    formData: TriggerFormData;
    isPending: boolean;
    onCancel: () => void;
    onChange: (data: TriggerFormData) => void;
    onSubmit: () => void;
    title: string;
}

const TriggerForm: FC<TriggerFormProps> = ({ formData, isPending, onCancel, onChange, onSubmit, title }) => {
    const { i18n, t } = useLingui();

    return (
        <Card>
            <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{t`Set up a new automated agent execution`}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Name */}
                <div className="space-y-1.5">
                    <Label htmlFor="trigger-name">{t`Name`}</Label>
                    <Input
                        id="trigger-name"
                        maxLength={100}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...formData, name: e.target.value })}
                        placeholder={t`Daily inbox summary`}
                        value={formData.name}
                    />
                </div>

                {/* Description */}
                <div className="space-y-1.5">
                    <Label htmlFor="trigger-desc">{t`Description (optional)`}</Label>
                    <Input
                        id="trigger-desc"
                        maxLength={500}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...formData, description: e.target.value })}
                        placeholder={t`Summarize my email inbox every morning`}
                        value={formData.description}
                    />
                </div>

                <Separator />

                {/* Type */}
                <div className="space-y-1.5">
                    <Label>{t`Trigger Type`}</Label>
                    <div aria-label={t`Trigger type`} className="flex gap-2" role="group">
                        {(["schedule", "webhook", "event"] as const).map((type) => (
                            <button
                                className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                                    formData.type === type
                                        ? "border-primary bg-primary/5 text-primary"
                                        : "border-border text-muted-foreground hover:border-primary/50"
                                }`}
                                key={type}
                                onClick={() => onChange({ ...formData, type })}
                                type="button"
                            >
                                {type === "schedule" && <Calendar aria-hidden="true" className="size-4" />}
                                {type === "webhook" && <Globe aria-hidden="true" className="size-4" />}
                                {type === "event" && <Zap aria-hidden="true" className="size-4" />}
                                {i18n._(TRIGGER_TYPE_LABELS[type])}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Schedule config */}
                {formData.type === "schedule" && (
                    <div className="space-y-3">
                        <div className="space-y-1.5">
                            <Label htmlFor="trigger-cron">{t`Cron Expression`}</Label>
                            <Input
                                id="trigger-cron"
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...formData, cronExpression: e.target.value })}
                                placeholder="0 8 * * *"
                                value={formData.cronExpression}
                            />
                            <div aria-label={t`Cron presets`} className="flex flex-wrap gap-1.5 pt-1" role="group">
                                {CRON_PRESETS.map((preset) => (
                                    <button
                                        className="text-muted-foreground hover:text-foreground rounded border px-2 py-0.5 text-[11px] transition-colors"
                                        key={preset.expression}
                                        onClick={() => onChange({ ...formData, cronExpression: preset.expression })}
                                        type="button"
                                    >
                                        {i18n._(preset.label)}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="trigger-tz">{t`Timezone`}</Label>
                            <Input
                                id="trigger-tz"
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...formData, timezone: e.target.value })}
                                placeholder="America/New_York"
                                value={formData.timezone}
                            />
                        </div>
                    </div>
                )}

                {/* Webhook info */}
                {formData.type === "webhook" && (
                    <div className="bg-muted rounded-lg p-3 text-sm">
                        <p className="text-muted-foreground">
                            <Trans>
                                A unique webhook URL and secret will be generated when you create this trigger. Use the URL as the target for external services
                                (Zapier, n8n, your own code, etc.).
                            </Trans>
                        </p>
                        <p className="text-muted-foreground mt-2">
                            <Trans>
                                Every request must be signed. Send <code className="font-mono">X-Neore-Timestamp</code> (the current Unix time in seconds) and{" "}
                                <code className="font-mono">X-Signature-256: sha256=&lt;hex&gt;</code>, the HMAC-SHA256 of{" "}
                                <code className="font-mono">&lt;timestamp&gt;.&lt;raw body&gt;</code> keyed with the secret. Requests more than 5 minutes old,
                                unsigned, or replayed are rejected.
                            </Trans>
                        </p>
                    </div>
                )}

                {/* Event info */}
                {formData.type === "event" && (
                    <div className="bg-muted rounded-lg p-3 text-sm">
                        <p className="text-muted-foreground">
                            <Trans>Event triggers via MCP/Composio are coming in Phase 2. For now, use webhook triggers to connect external services.</Trans>
                        </p>
                    </div>
                )}

                <Separator />

                {/* Agent config */}
                <div className="space-y-1.5">
                    <Label htmlFor="trigger-prompt">{t`System Prompt (optional)`}</Label>
                    <Textarea
                        id="trigger-prompt"
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ ...formData, systemPrompt: e.target.value })}
                        placeholder={t`You are a helpful assistant that summarizes emails...`}
                        rows={3}
                        value={formData.systemPrompt}
                    />
                </div>

                <div className="space-y-1.5">
                    <Label htmlFor="trigger-input">{t`Input Template`}</Label>
                    <Textarea
                        id="trigger-input"
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ ...formData, inputTemplate: e.target.value })}
                        placeholder={t`Summarize my inbox and highlight urgent items. Use ${PAYLOAD_TOKEN} for webhook data.`}
                        rows={2}
                        value={formData.inputTemplate}
                    />
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2 pt-2">
                    <Button onClick={onCancel} variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button disabled={isPending || !formData.name.trim()} onClick={onSubmit}>
                        {isPending && <Loader2 aria-hidden="true" className="mr-1.5 size-4 animate-spin" />}
                        {title}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const ExecutionStatusIcon = ({ status }: { status: string }) => {
    switch (status) {
        case "completed": {
            return <CheckCircle2 aria-hidden="true" className="size-3 text-green-500" />;
        }
        case "failed": {
            return <XCircle aria-hidden="true" className="size-3 text-red-500" />;
        }
        case "running": {
            return <Loader2 aria-hidden="true" className="size-3 animate-spin text-blue-500" />;
        }
        default: {
            return <Clock aria-hidden="true" className="text-muted-foreground size-3" />;
        }
    }
};

const TriggerTypeBadge = ({ type }: { type: string }) => {
    const { t } = useLingui();

    switch (type) {
        case "event": {
            return (
                <Badge variant="outline">
                    <Zap aria-hidden="true" className="mr-1 size-3" />
                    {t`Event`}
                </Badge>
            );
        }
        case "schedule": {
            return (
                <Badge variant="outline">
                    <Calendar aria-hidden="true" className="mr-1 size-3" />
                    {t`Schedule`}
                </Badge>
            );
        }
        case "webhook": {
            return (
                <Badge variant="outline">
                    <Globe aria-hidden="true" className="mr-1 size-3" />
                    {t`Webhook`}
                </Badge>
            );
        }
        default: {
            return <Badge variant="outline">{type}</Badge>;
        }
    }
};

const TriggerSettings: FC = () => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const executionStatusLabel = (status: string): string => {
        const label = EXECUTION_STATUS_LABELS[status];

        return label ? i18n._(label) : status;
    };
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [formData, setFormData] = useState<TriggerFormData>(EMPTY_FORM);
    // Both ids are only ever set from `trigger._id` of the triggers list, so they carry the row brand.
    const [editingTriggerId, setEditingTriggerId] = useState<Id<"triggers"> | null>(null);
    const [editFormData, setEditFormData] = useState<TriggerFormData>(EMPTY_FORM);
    const [expandedTriggerId, setExpandedTriggerId] = useState<Id<"triggers"> | null>(null);

    // Queries
    const { data: triggers, isLoading, refetch } = useQuery(crpc.triggers.functions.getTriggers.queryOptions({}));

    // Execution history query — only fetches when a trigger card is expanded
    // `skipToken` goes through `queryOptions` (the codebase convention) rather than
    // through a ternary over two differently-shaped options objects — the union of a
    // real options object and a hand-rolled skipped one has no matching `useQuery` overload.
    const { data: executions, isLoading: executionsLoading } = useQuery(
        crpc.triggers.functions.getTriggerExecutions.queryOptions(expandedTriggerId ? { limit: 10, triggerId: expandedTriggerId } : skipToken),
    );

    // Mutations
    const createMutation = useMutation(crpc.triggers.functions.createTrigger.mutationOptions());
    const updateMutation = useMutation(crpc.triggers.functions.updateTrigger.mutationOptions());
    const deleteMutation = useMutation(crpc.triggers.functions.deleteTrigger.mutationOptions());
    const enableMutation = useMutation(crpc.triggers.functions.setTriggerEnabled.mutationOptions());
    const { mutate: createTrigger } = createMutation;
    const { mutate: updateTrigger } = updateMutation;
    const { mutate: deleteTrigger } = deleteMutation;
    const { mutate: setTriggerEnabled } = enableMutation;

    // Test run action (uses useAction since it's a Lunora action, not a mutation)
    const testRunAction = useAction(api.triggers.functions.testRunTrigger);
    const [testRunning, setTestRunning] = useState<null | string>(null);

    const handleCreate = useCallback(() => {
        if (!formData.name.trim()) {
            toast.error(t`Trigger name is required`);

            return;
        }

        createTrigger(
            {
                cronExpression: formData.type === "schedule" ? formData.cronExpression : undefined,
                description: formData.description || undefined,
                inputTemplate: formData.inputTemplate || undefined,
                model: formData.model || "anthropic/claude-sonnet-4-20250514",
                name: formData.name,
                systemPrompt: formData.systemPrompt || undefined,
                timezone: formData.type === "schedule" ? formData.timezone : undefined,
                type: formData.type,
            },
            {
                onError: () => toast.error(t`Failed to create trigger`),
                onSuccess: (data) => {
                    toast.success(t`Trigger created`);
                    setShowCreateForm(false);
                    setFormData(EMPTY_FORM);
                    void refetch();

                    if ("webhookSecret" in data && data.webhookSecret) {
                        toast.info(t`Webhook secret copied to clipboard`, { duration: 5000 });
                        void navigator.clipboard.writeText(data.webhookSecret);
                    }
                },
            },
        );
    }, [createTrigger, formData, refetch, t]);

    const handleUpdate = useCallback(() => {
        if (!editingTriggerId || !editFormData.name.trim()) return;

        updateTrigger(
            {
                cronExpression: editFormData.type === "schedule" ? editFormData.cronExpression : undefined,
                description: editFormData.description || undefined,
                inputTemplate: editFormData.inputTemplate || undefined,
                model: editFormData.model || undefined,
                name: editFormData.name,
                systemPrompt: editFormData.systemPrompt || undefined,
                timezone: editFormData.type === "schedule" ? editFormData.timezone : undefined,
                triggerId: editingTriggerId,
            },
            {
                onError: () => toast.error(t`Failed to update trigger`),
                onSuccess: () => {
                    toast.success(t`Trigger updated`);
                    setEditingTriggerId(null);
                    void refetch();
                },
            },
        );
    }, [editingTriggerId, editFormData, updateTrigger, refetch, t]);

    const handleToggleEnabled = useCallback(
        (triggerId: Id<"triggers">, enabled: boolean) => {
            setTriggerEnabled(
                { enabled, triggerId },
                {
                    onError: () => toast.error(t`Failed to update trigger`),
                    onSuccess: () => {
                        toast.success(enabled ? t`Trigger enabled` : t`Trigger disabled`);
                        void refetch();
                    },
                },
            );
        },
        [setTriggerEnabled, refetch, t],
    );

    const handleDelete = useCallback(
        (triggerId: Id<"triggers">) => {
            deleteTrigger(
                { triggerId },
                {
                    onError: () => toast.error(t`Failed to delete trigger`),
                    onSuccess: () => {
                        toast.success(t`Trigger deleted`);

                        if (expandedTriggerId === triggerId) setExpandedTriggerId(null);

                        if (editingTriggerId === triggerId) setEditingTriggerId(null);

                        void refetch();
                    },
                },
            );
        },
        [deleteTrigger, refetch, expandedTriggerId, editingTriggerId, t],
    );

    const handleTestRun = useCallback(
        async (triggerId: Id<"triggers">) => {
            setTestRunning(triggerId);

            try {
                await testRunAction({ triggerId });
                toast.success(t`Test run scheduled — check your threads for the result`);
                void refetch();
            } catch {
                toast.error(t`Failed to start test run`);
            } finally {
                setTestRunning(null);
            }
        },
        [testRunAction, refetch, t],
    );

    const startEditing = useCallback((trigger: TriggerRow) => {
        setEditingTriggerId(trigger._id);
        setEditFormData({
            cronExpression: trigger.cronExpression ?? "0 8 * * *",
            description: trigger.description ?? "",
            inputTemplate: trigger.inputTemplate ?? "",
            model: trigger.model,
            name: trigger.name,
            systemPrompt: trigger.systemPrompt ?? "",
            timezone: trigger.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
            type: trigger.type as TriggerType,
        });
    }, []);

    const handleCopyWebhookUrl = useCallback(
        (triggerId: string) => {
            const url = `${env.VITE_LUNORA_URL}/triggers/webhook/${triggerId}`;

            void navigator.clipboard.writeText(url);
            toast.success(t`Webhook URL copied to clipboard`);
        },
        [t],
    );

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 py-8">
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
                <span className="text-muted-foreground text-sm">{t`Loading triggers...`}</span>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <Heading className="text-2xl font-bold tracking-tight">{t`Triggers`}</Heading>
                    <p className="text-muted-foreground">{t`Automate agent execution on schedules, webhooks, or events`}</p>
                </div>
                <Button disabled={showCreateForm} onClick={() => setShowCreateForm(true)} size="sm">
                    <Plus aria-hidden="true" className="mr-1.5 size-4" />
                    {t`New Trigger`}
                </Button>
            </div>

            <HeadingSection>
                {/* Create Form */}
                {showCreateForm && (
                    <TriggerForm
                        formData={formData}
                        isPending={createMutation.isPending}
                        onCancel={() => {
                            setShowCreateForm(false);
                            setFormData(EMPTY_FORM);
                        }}
                        onChange={setFormData}
                        onSubmit={handleCreate}
                        title={t`Create Trigger`}
                    />
                )}

                {/* Trigger List */}
                {triggers && triggers.length > 0 ? (
                    <div className="space-y-3">
                        {(triggers as TriggerRow[]).map((trigger) => {
                            const isEditing = editingTriggerId === trigger._id;

                            if (isEditing) {
                                return (
                                    <TriggerForm
                                        formData={editFormData}
                                        isPending={updateMutation.isPending}
                                        key={trigger._id}
                                        onCancel={() => setEditingTriggerId(null)}
                                        onChange={setEditFormData}
                                        onSubmit={handleUpdate}
                                        title={t`Edit Trigger`}
                                    />
                                );
                            }

                            const isExpanded = expandedTriggerId === trigger._id;
                            const runCount = trigger.triggerCount;
                            const lastRunAt = trigger.lastTriggeredAt ? formatDateTime(trigger.lastTriggeredAt, i18n.locale) : null;

                            return (
                                <Card key={trigger._id}>
                                    <CardContent className="p-4">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <CardHeading className="truncate font-medium">{trigger.name}</CardHeading>
                                                    <TriggerTypeBadge type={trigger.type} />
                                                    {trigger.enabled ? (
                                                        <Badge variant="default">{t`Active`}</Badge>
                                                    ) : (
                                                        <Badge variant="secondary">{t`Disabled`}</Badge>
                                                    )}
                                                </div>
                                                {trigger.description && <p className="text-muted-foreground mt-0.5 text-sm">{trigger.description}</p>}

                                                <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                                    {trigger.cronExpression && (
                                                        <span className="flex items-center gap-1">
                                                            <Clock aria-hidden="true" className="size-3" />
                                                            {trigger.cronExpression}
                                                            {trigger.timezone && ` (${trigger.timezone})`}
                                                        </span>
                                                    )}
                                                    <span>
                                                        <Trans>Runs: {runCount}</Trans>
                                                    </span>
                                                    {lastRunAt && (
                                                        <span suppressHydrationWarning>
                                                            <Trans>Last: {lastRunAt}</Trans>
                                                        </span>
                                                    )}
                                                </div>

                                                {/* Webhook URL display */}
                                                {trigger.type === "webhook" && (
                                                    <div className="mt-2 flex items-center gap-1.5">
                                                        <code className="bg-muted truncate rounded px-1.5 py-0.5 text-[11px]">
                                                            {env.VITE_LUNORA_URL}/triggers/webhook/{trigger._id}
                                                        </code>
                                                        <button
                                                            aria-label={t`Copy webhook URL`}
                                                            className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                                                            onClick={() => handleCopyWebhookUrl(trigger._id)}
                                                            type="button"
                                                        >
                                                            <Copy className="size-3" />
                                                        </button>
                                                    </div>
                                                )}

                                                {trigger.lastError && (
                                                    <div className="mt-2 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
                                                        <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                                                        <span className="line-clamp-2">{trigger.lastError}</span>
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex shrink-0 items-center gap-1">
                                                {/* Test run */}
                                                <Button
                                                    aria-label={t`Test run trigger`}
                                                    disabled={testRunning === trigger._id}
                                                    onClick={() => {
                                                        void handleTestRun(trigger._id);
                                                    }}
                                                    size="sm"
                                                    variant="ghost"
                                                >
                                                    {testRunning === trigger._id ? (
                                                        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                                                    ) : (
                                                        <Play aria-hidden="true" className="size-4" />
                                                    )}
                                                </Button>

                                                {/* Edit */}
                                                <Button aria-label={t`Edit trigger`} onClick={() => startEditing(trigger)} size="sm" variant="ghost">
                                                    <Pencil aria-hidden="true" className="size-4" />
                                                </Button>

                                                {/* Enable/disable */}
                                                <Switch
                                                    aria-label={trigger.enabled ? t`Disable trigger` : t`Enable trigger`}
                                                    checked={trigger.enabled}
                                                    disabled={enableMutation.isPending}
                                                    onCheckedChange={(checked: boolean) => handleToggleEnabled(trigger._id, checked)}
                                                    size="sm"
                                                />

                                                {/* Delete */}
                                                <Button
                                                    aria-label={t`Delete trigger`}
                                                    disabled={deleteMutation.isPending}
                                                    onClick={() => handleDelete(trigger._id)}
                                                    size="sm"
                                                    variant="ghost"
                                                >
                                                    <Trash2 aria-hidden="true" className="size-4 text-red-500" />
                                                </Button>
                                            </div>
                                        </div>

                                        {/* Expandable execution history */}
                                        <button
                                            className="text-muted-foreground hover:text-foreground mt-3 flex w-full items-center gap-1 border-t pt-3 text-xs transition-colors"
                                            onClick={() => setExpandedTriggerId(isExpanded ? null : trigger._id)}
                                            type="button"
                                        >
                                            {isExpanded ? (
                                                <ChevronDown aria-hidden="true" className="size-3" />
                                            ) : (
                                                <ChevronRight aria-hidden="true" className="size-3" />
                                            )}
                                            {t`Execution History`}
                                        </button>

                                        {isExpanded && (
                                            <div className="mt-2 space-y-1.5">
                                                {executionsLoading && (
                                                    <div className="flex items-center gap-2 py-2">
                                                        <Loader2 className="text-muted-foreground size-3 animate-spin" />
                                                        <span className="text-muted-foreground text-xs">{t`Loading...`}</span>
                                                    </div>
                                                )}
                                                {!executionsLoading &&
                                                    executions &&
                                                    executions.length > 0 &&
                                                    executions.map((exec: TriggerExecutionRow) => (
                                                        <div
                                                            className="bg-muted/50 flex items-center justify-between rounded-md px-3 py-2 text-xs"
                                                            key={exec._id}
                                                        >
                                                            <div className="flex items-center gap-2">
                                                                <ExecutionStatusIcon status={exec.status} />
                                                                <span className="capitalize">{executionStatusLabel(exec.status)}</span>
                                                                <span className="text-muted-foreground" suppressHydrationWarning>
                                                                    {formatDateTime(exec.startedAt, i18n.locale)}
                                                                </span>
                                                                {exec.completedAt && (
                                                                    <span className="text-muted-foreground">
                                                                        ({Math.round((exec.completedAt - exec.startedAt) / 1000)}s)
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                {exec.error && (
                                                                    <span className="max-w-[200px] truncate text-red-500" title={exec.error}>
                                                                        {exec.error}
                                                                    </span>
                                                                )}
                                                                {exec.threadId && (
                                                                    <a
                                                                        className="text-primary flex items-center gap-0.5 hover:underline"
                                                                        href={`/chat/${exec.threadId}`}
                                                                    >
                                                                        <ExternalLink aria-hidden="true" className="size-3" />
                                                                        {t`Thread`}
                                                                    </a>
                                                                )}
                                                            </div>
                                                        </div>
                                                    ))}
                                                {!executionsLoading && !(executions && executions.length > 0) && (
                                                    <p className="text-muted-foreground py-2 text-xs">{t`No executions yet`}</p>
                                                )}
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                ) : (
                    !showCreateForm && (
                        <Card>
                            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                                <Zap aria-hidden="true" className="text-muted-foreground mb-3 size-10 opacity-40" />
                                <CardHeading className="text-lg font-medium">{t`No triggers yet`}</CardHeading>
                                <p className="text-muted-foreground mt-1 max-w-sm text-sm">
                                    {t`Create your first trigger to automate agent execution on a schedule, via webhooks, or from external events.`}
                                </p>
                                <Button className="mt-4" onClick={() => setShowCreateForm(true)} size="sm">
                                    <Plus aria-hidden="true" className="mr-1.5 size-4" />
                                    {t`Create Trigger`}
                                </Button>
                            </CardContent>
                        </Card>
                    )
                )}

                {/* Info card */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">{t`How Triggers Work`}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-muted-foreground space-y-3 text-sm">
                        <div className="flex items-start gap-2">
                            <Calendar aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                            <div>
                                <Trans>
                                    <span className="text-foreground font-medium">Schedule</span> — Run on a cron schedule (e.g., daily at 8 AM). Uses standard
                                    5-field cron expressions.
                                </Trans>
                            </div>
                        </div>
                        <div className="flex items-start gap-2">
                            <Globe aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                            <div>
                                <Trans>
                                    <span className="text-foreground font-medium">Webhook</span> — Receive HTTP POST requests from external services (Stripe,
                                    GitHub, Zapier). Requests are signed with a timestamped HMAC and replays are rejected.
                                </Trans>
                            </div>
                        </div>
                        <div className="flex items-start gap-2">
                            <Zap aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                            <div>
                                <Trans>
                                    <span className="text-foreground font-medium">Event</span> — React to external events via MCP or Composio (coming in Phase
                                    2).
                                </Trans>
                            </div>
                        </div>
                        <p className="border-t pt-3 text-xs">
                            <Trans>
                                Each trigger creates a new thread and runs your agent with up to 25 iterations (Deep Work mode). Results are visible in your
                                thread list.
                            </Trans>
                        </p>
                    </CardContent>
                </Card>
            </HeadingSection>
        </div>
    );
};

export default TriggerSettings;
