"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import type { WebhookPresetEvent, WebhookProvider, WebhookSignatureScheme } from "@neore/backend/triggers/presets";
import { PRESET_EVENTS, PROVIDER_SCHEME } from "@neore/backend/triggers/presets";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardHeading, CardTitle } from "@neore/ui/components/card";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Heading, HeadingSection } from "@neore/ui/components/heading";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
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
    Filter,
    Globe,
    Loader2,
    Pencil,
    Play,
    Plus,
    Trash2,
    X,
    XCircle,
    Zap,
} from "lucide-react";
import type { FC } from "react";
import { useCallback, useId, useState } from "react";
import { toast } from "sonner";

import type { FilterOp, PayloadFilterRow } from "@/features/settings/lib/trigger-filters";
import {
    filtersToSend,
    hasIncompleteFilters,
    isValidFilterPath,
    MAX_FILTER_PATH_LENGTH,
    MAX_FILTER_VALUE_LENGTH,
    MAX_FILTERS,
    opTakesValue,
} from "@/features/settings/lib/trigger-filters";
import env from "@/lib/env";
import { useAction, useCRPC } from "@/lib/lunora/crpc";

import TriggerTypePicker from "./trigger-type-picker";

/** The template variable a webhook trigger fills with the request body; code, not copy. */
const PAYLOAD_TOKEN = "{{payload}}";

// ─── Types ─────────────────────────────────────────────────────────────────

type TriggerType = "event" | "schedule" | "webhook";

/** "custom" is a hand-written trigger: its own scheme and filters. A provider sets both from its event. */
type WebhookSourceChoice = "custom" | WebhookProvider;

/**
 * The schemes a hand-written webhook trigger can pick. Fixed when the trigger is created, with its secret.
 * `linear` is not offered: Linear generates its own signing secret and takes none from the caller, so a
 * trigger's server-minted secret can never verify a Linear delivery until a provider-supplied secret is stored.
 */
const CUSTOM_SCHEMES: WebhookSignatureScheme[] = ["timestamped", "native", "gitlab-token"];

const SCHEME_LABELS: Record<WebhookSignatureScheme, MessageDescriptor> = {
    linear: msg`Linear (Linear-Signature)`,
    "gitlab-token": msg`GitLab secret token (X-Gitlab-Token)`,
    native: msg`GitHub-style (X-Hub-Signature-256)`,
    timestamped: msg`Neore (timestamped)`,
};

const PROVIDER_LABELS: Record<WebhookSourceChoice, MessageDescriptor> = {
    custom: msg`Custom`,
    github: msg`GitHub`,
    gitlab: msg`GitLab`,
};

const PRESET_EVENT_LABELS: Record<WebhookPresetEvent, MessageDescriptor> = {
    issue_assigned: msg`Issue assigned`,
    merge_request_merged: msg`Merge request merged`,
    merge_request_opened: msg`Merge request opened`,
    pull_request_merged: msg`Pull request merged`,
    pull_request_opened: msg`Pull request opened`,
    pull_request_review_requested: msg`Review requested on a pull request`,
};

const FILTER_OP_LABELS: Record<FilterOp, MessageDescriptor> = {
    contains: msg`contains`,
    equals: msg`equals`,
    exists: msg`exists`,
    not_equals: msg`does not equal`,
    not_exists: msg`does not exist`,
    starts_with: msg`starts with`,
};

interface TriggerFormData {
    botComputer: boolean;
    botId: string;
    cronExpression: string;
    description: string;
    filters: PayloadFilterRow[];
    inputTemplate: string;
    model: string;
    name: string;
    quietWhenEmpty: boolean;
    systemPrompt: string;
    timezone: string;
    type: TriggerType;
    /** A provider's event, when the source is a provider; the event is always one of that provider's. */
    webhookEvent: WebhookPresetEvent;
    webhookSignatureScheme: WebhookSignatureScheme;
    webhookSource: WebhookSourceChoice;
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
    botComputer: boolean;
    botId: string | null;
    createdAt: number;
    cronExpression: string | null;
    description: string | null;
    enabled: boolean;
    filters: { op: FilterOp; path: string; value: string | null }[];
    inputTemplate: string | null;
    lastError: string | null;
    lastTriggeredAt: number | null;
    model: string;
    name: string;
    nextTriggerAt: number | null;
    quietWhenEmpty: boolean;
    searchMode: string | null;
    systemPrompt: string | null;
    timezone: string | null;
    triggerCount: number;
    type: string;
    updatedAt: number;
    webhookSignatureScheme: WebhookSignatureScheme | null;
}

interface TriggerExecutionRow {
    _id: string;
    completedAt: number | null;
    error: string | null;
    startedAt: number;
    status: string;
    threadId: string | null;
}

/** Stands in for "no bot" in the picker: a select value cannot be empty. */
const NO_BOT = "__no_bot__";

const EMPTY_FORM: TriggerFormData = {
    botComputer: false,
    botId: "",
    cronExpression: "0 8 * * *",
    description: "",
    filters: [],
    inputTemplate: "",
    model: "",
    name: "",
    quietWhenEmpty: false,
    systemPrompt: "",
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    type: "schedule",
    webhookEvent: PRESET_EVENTS.github[0],
    webhookSignatureScheme: "timestamped",
    webhookSource: "custom",
};

const CRON_PRESETS: { expression: string; label: MessageDescriptor }[] = [
    { expression: "0 8 * * *", label: msg`Every day at 8 AM` },
    { expression: "0 8 * * 1-5", label: msg`Weekdays at 8 AM` },
    { expression: "0 */6 * * *", label: msg`Every 6 hours` },
    { expression: "0 0 * * 0", label: msg`Every Sunday at midnight` },
    { expression: "0 9 1 * *", label: msg`First of each month at 9 AM` },
];

const EXECUTION_STATUS_LABELS: Partial<Record<string, MessageDescriptor>> = {
    completed: msg`Completed`,
    failed: msg`Failed`,
    filtered: msg`Filtered`,
    pending: msg`Pending`,
    running: msg`Running`,
};

// ─── Component ─────────────────────────────────────────────────────────────

// ─── Shared Trigger Form ────────────────────────────────────────────────────

/** Edits a webhook trigger's payload filters: every filter must match the JSON body for a delivery to run. */
const PayloadFiltersEditor: FC<{ filters: PayloadFilterRow[]; onChange: (filters: PayloadFilterRow[]) => void }> = ({ filters, onChange }) => {
    const { i18n, t } = useLingui();
    // Generated id: the create and edit forms can be open together.
    const labelId = useId();
    const update = (index: number, patch: Partial<PayloadFilterRow>) =>
        onChange(filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)));

    return (
        <div aria-labelledby={labelId} className="space-y-2" role="group">
            <Label id={labelId}>{t`Payload filters (optional)`}</Label>
            <p className="text-muted-foreground text-xs">
                {t`Only run when every filter matches the JSON body. Use dotted paths such as pull_request.user.login or labels.0.name. A delivery that does not match is accepted, shown as Filtered in the history, and does not run or count against your quota.`}
            </p>
            {filters.map((filter, index) => (
                // The rows have no identity of their own; they are only ever added at the end or removed.

                <div className="flex items-start gap-2" key={index}>
                    <Input
                        aria-invalid={filter.path.length > 0 && !isValidFilterPath(filter.path)}
                        aria-label={t`Filter path`}
                        className="min-w-0 flex-1 font-mono text-xs"
                        maxLength={MAX_FILTER_PATH_LENGTH}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => update(index, { path: e.target.value })}
                        placeholder="action"
                        value={filter.path}
                    />
                    <Select onValueChange={(value) => update(index, { op: value as FilterOp })} value={filter.op}>
                        <SelectTrigger aria-label={t`Filter condition`} className="w-40 shrink-0">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {(Object.keys(FILTER_OP_LABELS) as FilterOp[]).map((op) => (
                                <SelectItem key={op} value={op}>
                                    {i18n._(FILTER_OP_LABELS[op])}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {opTakesValue(filter.op) && (
                        <Input
                            aria-label={t`Filter value`}
                            className="min-w-0 flex-1 text-xs"
                            maxLength={MAX_FILTER_VALUE_LENGTH}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => update(index, { value: e.target.value })}
                            placeholder="opened"
                            value={filter.value}
                        />
                    )}
                    <Button
                        aria-label={t`Remove filter`}
                        onClick={() => onChange(filters.filter((_, at) => at !== index))}
                        size="sm"
                        type="button"
                        variant="ghost"
                    >
                        <X aria-hidden="true" className="size-4" />
                    </Button>
                </div>
            ))}
            <Button
                disabled={filters.length >= MAX_FILTERS}
                onClick={() => onChange([...filters, { op: "equals", path: "", value: "" }])}
                size="sm"
                type="button"
                variant="outline"
            >
                <Plus aria-hidden="true" className="mr-1.5 size-3" />
                {t`Add filter`}
            </Button>
        </div>
    );
};

/** What a sender must send for each scheme. Requests of the other scheme are rejected. */
const WebhookSigningInstructions: FC<{ scheme: WebhookSignatureScheme }> = ({ scheme }) => {
    if (scheme === "native") {
        return (
            <p className="text-muted-foreground mt-2">
                <Trans>
                    Send <code className="font-mono">X-Hub-Signature-256: sha256=&lt;hex&gt;</code>, the HMAC-SHA256 of the raw request body keyed with the
                    secret (the format GitHub webhooks use). This signature has no timestamp, so a captured request can be replayed once the 15-minute duplicate
                    window has passed. Requests with the neore headers are rejected.
                </Trans>
            </p>
        );
    }

    if (scheme === "gitlab-token") {
        return (
            <p className="text-muted-foreground mt-2">
                <Trans>
                    Send the secret as <code className="font-mono">X-Gitlab-Token</code>, in plain text, as GitLab&apos;s secret token works. GitLab does not
                    sign the body and sends no timestamp, so the secret is a bearer token: whoever holds it can send any request. An identical body is treated
                    as a duplicate for 15 minutes. Requests carrying other signature headers are rejected.
                </Trans>
            </p>
        );
    }

    if (scheme === "linear") {
        return (
            <p className="text-muted-foreground mt-2">
                <Trans>
                    Send <code className="font-mono">Linear-Signature: &lt;hex&gt;</code>, the HMAC-SHA256 of the raw request body keyed with the secret, as
                    bare hex with no prefix. The body&apos;s <code className="font-mono">webhookTimestamp</code> (milliseconds) must be within 5 minutes.
                    Requests carrying the neore or GitHub headers are rejected.
                </Trans>
            </p>
        );
    }

    return (
        <p className="text-muted-foreground mt-2">
            <Trans>
                Every request must be signed. Send <code className="font-mono">X-Neore-Timestamp</code> (the current Unix time in seconds) and{" "}
                <code className="font-mono">X-Signature-256: sha256=&lt;hex&gt;</code>, the HMAC-SHA256 of{" "}
                <code className="font-mono">&lt;timestamp&gt;.&lt;raw body&gt;</code> keyed with the secret. Requests more than 5 minutes old, unsigned, or
                replayed are rejected, as is <code className="font-mono">X-Hub-Signature-256</code>.
            </Trans>
        </p>
    );
};

interface TriggerFormProps {
    formData: TriggerFormData;
    /** An existing trigger keeps its type and the scheme its secret was issued for. */
    isExisting?: boolean;
    isPending: boolean;
    onCancel: () => void;
    onChange: (data: TriggerFormData) => void;
    onSubmit: () => void;
    title: string;
}

const TriggerForm: FC<TriggerFormProps> = ({ formData, isPending, onCancel, onChange, onSubmit, isExisting = false, title }) => {
    // Generated ids: the create and edit forms can be open together, and fixed ids would make their labels ambiguous.
    const botPickerId = useId();
    const botComputerId = useId();
    const quietId = useId();
    const schemeId = useId();
    const sourceId = useId();
    const eventId = useId();
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const { data: bots = [] } = useQuery(crpc.bots.functions.listBots.queryOptions({}));

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
                {/* Bot: a routine that names a bot runs on the bot's model and instructions */}
                <div className="space-y-1.5">
                    <Label htmlFor={botPickerId}>{t`Run as bot (optional)`}</Label>
                    <Select
                        onValueChange={(value) => onChange({ ...formData, botComputer: false, botId: value === NO_BOT ? "" : (value ?? "") })}
                        value={formData.botId || NO_BOT}
                    >
                        <SelectTrigger id={botPickerId}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={NO_BOT}>{t`No bot`}</SelectItem>
                            {bots.map((bot) => (
                                <SelectItem key={bot._id} value={bot._id}>
                                    {bot.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                {formData.type === "schedule" && bots.some((bot) => bot._id === formData.botId && bot.computerEnabled) && (
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <Label htmlFor={botComputerId}>{t`Let the bot use its computer`}</Label>
                            <p className="text-muted-foreground text-xs">
                                {t`Scheduled runs can run shell commands and edit files on the bot's computer, unless you turn those tools off in your tool settings.`}
                            </p>
                        </div>
                        <Switch
                            checked={formData.botComputer}
                            id={botComputerId}
                            onCheckedChange={(checked: boolean) => onChange({ ...formData, botComputer: checked })}
                        />
                    </div>
                )}
                {formData.type === "schedule" && formData.botId !== "" && (
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <Label htmlFor={quietId}>{t`Only post when there is something to report`}</Label>
                            <p className="text-muted-foreground text-xs">
                                {t`Skips a run when your workspace has had no new activity since the routine last posted. A skipped run creates no chat and sends no notification.`}
                            </p>
                        </div>
                        <Switch
                            checked={formData.quietWhenEmpty}
                            id={quietId}
                            onCheckedChange={(checked: boolean) => onChange({ ...formData, quietWhenEmpty: checked })}
                        />
                    </div>
                )}

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
                    <TriggerTypePicker
                        disabled={isExisting || formData.type === "event"}
                        onSelect={(type) => onChange({ ...formData, type })}
                        value={formData.type}
                    />
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
                        <div className="mt-3 space-y-1.5">
                            <Label htmlFor={sourceId}>{t`Source`}</Label>
                            <Select
                                disabled={isExisting}
                                onValueChange={(value) => {
                                    const source = value as WebhookSourceChoice;

                                    // A provider's event is one of that provider's, so switching provider resets it.
                                    onChange({
                                        ...formData,
                                        webhookEvent: source === "custom" ? formData.webhookEvent : PRESET_EVENTS[source][0],
                                        webhookSource: source,
                                    });
                                }}
                                value={formData.webhookSource}
                            >
                                <SelectTrigger id={sourceId}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {(Object.keys(PROVIDER_LABELS) as WebhookSourceChoice[]).map((source) => (
                                        <SelectItem key={source} value={source}>
                                            {t(PROVIDER_LABELS[source])}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        {formData.webhookSource === "custom" ? (
                            <>
                                <div className="mt-3 space-y-1.5">
                                    <Label htmlFor={schemeId}>{t`Signature`}</Label>
                                    <Select
                                        disabled={isExisting}
                                        onValueChange={(value) => onChange({ ...formData, webhookSignatureScheme: value as WebhookSignatureScheme })}
                                        value={formData.webhookSignatureScheme}
                                    >
                                        <SelectTrigger id={schemeId}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {CUSTOM_SCHEMES.map((scheme) => (
                                                <SelectItem key={scheme} value={scheme}>
                                                    {t(SCHEME_LABELS[scheme])}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <WebhookSigningInstructions scheme={formData.webhookSignatureScheme} />
                                <div className="mt-4">
                                    <PayloadFiltersEditor filters={formData.filters} onChange={(filters) => onChange({ ...formData, filters })} />
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="mt-3 space-y-1.5">
                                    <Label htmlFor={eventId}>{t`Event`}</Label>
                                    <Select
                                        disabled={isExisting}
                                        onValueChange={(value) => onChange({ ...formData, webhookEvent: value as WebhookPresetEvent })}
                                        value={formData.webhookEvent}
                                    >
                                        <SelectTrigger id={eventId}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {PRESET_EVENTS[formData.webhookSource].map((event) => (
                                                <SelectItem key={event} value={event}>
                                                    {t(PRESET_EVENT_LABELS[event])}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <p className="text-muted-foreground mt-2">
                                    <Trans>The filters and the signature come from the event. Only the provider&apos;s own deliveries for it run.</Trans>
                                </p>
                                <WebhookSigningInstructions scheme={PROVIDER_SCHEME[formData.webhookSource]} />
                            </>
                        )}
                    </div>
                )}

                {/* An existing event trigger: nothing dispatches it, so it cannot be saved. */}
                {formData.type === "event" && (
                    <div className="bg-muted rounded-lg p-3 text-sm" role="status">
                        <p className="text-muted-foreground">
                            <Trans>
                                Event triggers are not supported: nothing starts this one automatically, and it cannot be edited. Delete it and create a
                                schedule or webhook trigger instead.
                            </Trans>
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
                    <Button
                        disabled={isPending || !formData.name.trim() || formData.type === "event" || hasIncompleteFilters(formData.type, formData.filters)}
                        onClick={onSubmit}
                    >
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
        case "filtered": {
            return <Filter aria-hidden="true" className="text-muted-foreground size-3" />;
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
    // The plaintext webhook secret is returned only by `createTrigger`, so it is shown once, here.
    const [newWebhookSecret, setNewWebhookSecret] = useState<string | null>(null);
    const [deletingTrigger, setDeletingTrigger] = useState<TriggerRow | null>(null);

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

        // A provider sends its event; the server compiles the filters and the scheme. A custom trigger sends its own.
        const isProviderWebhook = formData.type === "webhook" && formData.webhookSource !== "custom";
        const isCustomWebhook = formData.type === "webhook" && formData.webhookSource === "custom";

        createTrigger(
            {
                botComputer: formData.type === "schedule" && formData.botId !== "" && formData.botComputer ? true : undefined,
                botId: formData.botId || undefined,
                cronExpression: formData.type === "schedule" ? formData.cronExpression : undefined,
                description: formData.description || undefined,
                filters: isCustomWebhook && formData.filters.length > 0 ? filtersToSend(formData.filters) : undefined,
                inputTemplate: formData.inputTemplate || undefined,
                model: formData.model || "anthropic/claude-sonnet-4-20250514",
                name: formData.name,
                quietWhenEmpty: formData.type === "schedule" && formData.botId !== "" && formData.quietWhenEmpty ? true : undefined,
                systemPrompt: formData.systemPrompt || undefined,
                timezone: formData.type === "schedule" ? formData.timezone : undefined,
                type: formData.type,
                webhookPreset:
                    isProviderWebhook && formData.webhookSource !== "custom" ? { event: formData.webhookEvent, provider: formData.webhookSource } : undefined,
                webhookSignatureScheme: isCustomWebhook ? formData.webhookSignatureScheme : undefined,
            },
            {
                onError: () => toast.error(t`Failed to create trigger`),
                onSuccess: (data) => {
                    toast.success(t`Trigger created`);
                    setShowCreateForm(false);
                    setFormData(EMPTY_FORM);
                    void refetch();

                    setNewWebhookSecret(data.webhookSecret ?? null);
                },
            },
        );
    }, [createTrigger, formData, refetch, t]);

    const handleUpdate = useCallback(() => {
        if (!editingTriggerId || !editFormData.name.trim()) return;

        updateTrigger(
            {
                // `null` clears the bot; the form always carries the row's current botId, so this is never "leave unchanged".
                botComputer: editFormData.type === "schedule" && editFormData.botId !== "" && editFormData.botComputer,
                botId: editFormData.botId || null,
                cronExpression: editFormData.type === "schedule" ? editFormData.cronExpression : undefined,
                description: editFormData.description || undefined,
                // The whole set replaces the stored one; an empty set clears it.
                filters: editFormData.type === "webhook" ? filtersToSend(editFormData.filters) : undefined,
                inputTemplate: editFormData.inputTemplate || undefined,
                model: editFormData.model || undefined,
                name: editFormData.name,
                quietWhenEmpty: editFormData.type === "schedule" && editFormData.botId !== "" && editFormData.quietWhenEmpty,
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

    const handleConfirmDelete = useCallback(() => {
        if (!deletingTrigger) return;

        const triggerId = deletingTrigger._id;

        deleteTrigger(
            { triggerId },
            {
                onError: () => toast.error(t`Failed to delete trigger`),
                onSuccess: () => {
                    toast.success(t`Trigger deleted`);
                    setDeletingTrigger(null);

                    if (expandedTriggerId === triggerId) setExpandedTriggerId(null);

                    if (editingTriggerId === triggerId) setEditingTriggerId(null);

                    void refetch();
                },
            },
        );
    }, [deleteTrigger, deletingTrigger, refetch, expandedTriggerId, editingTriggerId, t]);

    const handleCopyWebhookSecret = useCallback(async () => {
        if (!newWebhookSecret) return;

        try {
            await navigator.clipboard.writeText(newWebhookSecret);
            toast.success(t`Webhook secret copied to clipboard`);
        } catch {
            toast.error(t`Could not copy the secret. Select it and copy it manually.`);
        }
    }, [newWebhookSecret, t]);

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
            botComputer: trigger.botComputer,
            botId: trigger.botId ?? "",
            cronExpression: trigger.cronExpression ?? "0 8 * * *",
            description: trigger.description ?? "",
            filters: trigger.filters.map((filter) => {
                return { op: filter.op, path: filter.path, value: filter.value ?? "" };
            }),
            inputTemplate: trigger.inputTemplate ?? "",
            model: trigger.model,
            name: trigger.name,
            quietWhenEmpty: trigger.quietWhenEmpty,
            systemPrompt: trigger.systemPrompt ?? "",
            timezone: trigger.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
            type: trigger.type as TriggerType,
            // A stored trigger keeps its own filters and scheme; the provider it came from is not stored.
            webhookEvent: PRESET_EVENTS.github[0],
            webhookSignatureScheme: trigger.webhookSignatureScheme ?? "timestamped",
            webhookSource: "custom",
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
                    <p className="text-muted-foreground">{t`Automate agent execution on schedules or webhooks`}</p>
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

                {newWebhookSecret && (
                    <Card className="border-amber-500/50">
                        <CardContent className="space-y-2 p-4">
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <CardHeading className="font-medium">{t`Webhook secret`}</CardHeading>
                                    <p className="text-muted-foreground text-sm">
                                        {t`Copy this secret now and store it with your webhook sender. It will not be shown again.`}
                                    </p>
                                </div>
                                <Button aria-label={t`Dismiss webhook secret`} onClick={() => setNewWebhookSecret(null)} size="sm" variant="ghost">
                                    <X aria-hidden="true" className="size-4" />
                                </Button>
                            </div>
                            <div className="flex items-center gap-2">
                                <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-xs select-all">{newWebhookSecret}</code>
                                <Button
                                    onClick={() => {
                                        void handleCopyWebhookSecret();
                                    }}
                                    size="sm"
                                    variant="outline"
                                >
                                    <Copy aria-hidden="true" className="mr-1.5 size-3" />
                                    {t`Copy`}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Trigger List */}
                {triggers && triggers.length > 0 ? (
                    <div className="space-y-3">
                        {(
                            triggers.map((trigger) => {
                                return { ...trigger, _id: trigger._id as Id<"triggers"> };
                            }) as TriggerRow[]
                        ).map((trigger) => {
                            const isEditing = editingTriggerId === trigger._id;

                            if (isEditing) {
                                return (
                                    <TriggerForm
                                        formData={editFormData}
                                        isExisting
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
                                                {trigger.type === "webhook" && (
                                                    <div className="text-xs">
                                                        <WebhookSigningInstructions scheme={trigger.webhookSignatureScheme ?? "timestamped"} />
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
                                                    onClick={() => setDeletingTrigger(trigger)}
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
                                                                    <span
                                                                        className={`max-w-[200px] truncate ${exec.status === "filtered" ? "text-muted-foreground" : "text-red-500"}`}
                                                                        title={exec.error}
                                                                    >
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
                                    {t`Create your first trigger to automate agent execution on a schedule or via webhooks.`}
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
                        <p className="border-t pt-3 text-xs">
                            <Trans>
                                Each trigger creates a new thread and runs your agent with up to 25 iterations (Deep Work mode). Results are visible in your
                                thread list.
                            </Trans>
                        </p>
                    </CardContent>
                </Card>
            </HeadingSection>

            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={t`The trigger stops running and its execution history is removed. This cannot be undone.`}
                loading={deleteMutation.isPending}
                onConfirm={handleConfirmDelete}
                onOpenChange={(open) => !open && !deleteMutation.isPending && setDeletingTrigger(null)}
                open={deletingTrigger !== null}
                title={deletingTrigger ? t`Delete "${deletingTrigger.name}"?` : t`Delete trigger?`}
            />
        </div>
    );
};

export default TriggerSettings;
