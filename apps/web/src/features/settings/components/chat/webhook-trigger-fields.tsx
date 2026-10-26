"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { WebhookPreset, WebhookSignatureScheme } from "@neore/backend/triggers/presets";
import { WEBHOOK_PRESET_LIST, WEBHOOK_PRESETS, WEBHOOK_PROVIDERS } from "@neore/backend/triggers/presets";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Plus, X } from "lucide-react";
import type { FC } from "react";
import { useId } from "react";

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

/**
 * Where a webhook trigger comes from. A hand-written one has its own signature scheme and payload filters; a
 * provider's is one of its events, and the server compiles the filters and the scheme from it. The two
 * share nothing, so each carries only its own fields.
 */
export type WebhookFormState = WebhookPreset | { filters: PayloadFilterRow[]; provider: "custom"; scheme: WebhookSignatureScheme };

export const EMPTY_WEBHOOK: WebhookFormState = { filters: [], provider: "custom", scheme: "timestamped" };

/** The webhook arguments of `createTrigger`. A trigger that is not a webhook sends none. */
export const webhookCreateArgs = (
    type: string,
    webhook: WebhookFormState,
): { filters?: ReturnType<typeof filtersToSend>; webhookPreset?: WebhookPreset; webhookSignatureScheme?: WebhookSignatureScheme } => {
    if (type !== "webhook") {
        return {};
    }

    return webhook.provider === "custom"
        ? { filters: webhook.filters.length > 0 ? filtersToSend(webhook.filters) : undefined, webhookSignatureScheme: webhook.scheme }
        : { webhookPreset: webhook };
};

/** The filters an update sends: the whole set replaces the stored one, and an empty set clears it. A provider's are not editable. */
export const webhookUpdateFilters = (webhook: WebhookFormState) => (webhook.provider === "custom" ? filtersToSend(webhook.filters) : undefined);

/** Only a hand-written webhook has filter rows that can be left half-filled. */
export const webhookHasIncompleteFilters = (webhook: WebhookFormState): boolean =>
    webhook.provider === "custom" && hasIncompleteFilters("webhook", webhook.filters);

type WebhookSourceChoice = WebhookFormState["provider"];

const SOURCE_CHOICES: ReadonlyArray<WebhookSourceChoice> = ["custom", ...WEBHOOK_PROVIDERS];

/** The schemes a hand-written webhook trigger can pick, in the order the picker lists them. Fixed when the trigger is created, with its secret. */
const CUSTOM_SCHEMES: ReadonlyArray<WebhookSignatureScheme> = ["timestamped", "native", "gitlab-token"];

const isOneOf = <T extends string>(list: ReadonlyArray<T>, value: unknown): value is T => {
    const items: ReadonlyArray<unknown> = list;

    return items.includes(value);
};

const SCHEME_LABELS: Record<WebhookSignatureScheme, MessageDescriptor> = {
    "gitlab-token": msg`GitLab secret token (X-Gitlab-Token)`,
    native: msg`GitHub-style (X-Hub-Signature-256)`,
    timestamped: msg`Neore (timestamped)`,
};

const PROVIDER_LABELS: Record<WebhookSourceChoice, MessageDescriptor> = {
    custom: msg`Custom`,
    github: msg`GitHub`,
    gitlab: msg`GitLab`,
};

const PRESET_EVENT_LABELS: Record<WebhookPreset["event"], MessageDescriptor> = {
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
export const WebhookSigningInstructions: FC<{ scheme: WebhookSignatureScheme }> = ({ scheme }) => {
    switch (scheme) {
        case "gitlab-token": {
            return (
                <p className="text-muted-foreground mt-2">
                    <Trans>
                        Send the secret as <code className="font-mono">X-Gitlab-Token</code>, in plain text, as GitLab&apos;s secret token works. GitLab does
                        not sign the body and sends no timestamp, so the secret is a bearer token: whoever holds it can send any request. Every delivery must
                        also carry <code className="font-mono">X-Gitlab-Event-UUID</code>, which GitLab sends itself. Each accepted delivery is remembered by
                        that UUID and its body, and a resend of it is answered as a duplicate. Requests carrying other signature headers are rejected.
                    </Trans>
                </p>
            );
        }
        case "native": {
            return (
                <p className="text-muted-foreground mt-2">
                    <Trans>
                        Send <code className="font-mono">X-Hub-Signature-256: sha256=&lt;hex&gt;</code>, the HMAC-SHA256 of the raw request body keyed with the
                        secret (the format GitHub webhooks use). This signature has no timestamp, so a captured request can be replayed once the 15-minute
                        duplicate window has passed. Requests with the neore headers are rejected.
                    </Trans>
                </p>
            );
        }
        case "timestamped": {
            return (
                <p className="text-muted-foreground mt-2">
                    <Trans>
                        Every request must be signed. Send <code className="font-mono">X-Neore-Timestamp</code> (the current Unix time in seconds) and{" "}
                        <code className="font-mono">X-Signature-256: sha256=&lt;hex&gt;</code>, the HMAC-SHA256 of{" "}
                        <code className="font-mono">&lt;timestamp&gt;.&lt;raw body&gt;</code> keyed with the secret. Requests more than 5 minutes old, unsigned,
                        or replayed are rejected, as is <code className="font-mono">X-Hub-Signature-256</code>.
                    </Trans>
                </p>
            );
        }
        default: {
            const unhandled: never = scheme;

            return unhandled;
        }
    }
};

interface WebhookTriggerFieldsProps {
    /** An existing trigger keeps the source and the scheme its secret was issued for. */
    isExisting: boolean;
    onChange: (webhook: WebhookFormState) => void;
    webhook: WebhookFormState;
}

/** The source, event or signature, and filters of a webhook trigger. */
export const WebhookTriggerFields: FC<WebhookTriggerFieldsProps> = ({ isExisting, onChange, webhook }) => {
    const { t } = useLingui();
    const schemeId = useId();
    const sourceId = useId();
    const eventId = useId();

    const changeSource = (value: unknown) => {
        if (!isOneOf(SOURCE_CHOICES, value)) {
            return;
        }

        // A provider's event is one of that provider's, so switching provider starts on its first event.
        const next = value === "custom" ? EMPTY_WEBHOOK : WEBHOOK_PRESET_LIST.find((preset) => preset.provider === value);

        if (next) {
            onChange(next);
        }
    };

    return (
        <>
            <div className="mt-3 space-y-1.5">
                <Label htmlFor={sourceId}>{t`Source`}</Label>
                <Select disabled={isExisting} onValueChange={changeSource} value={webhook.provider}>
                    <SelectTrigger id={sourceId}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {SOURCE_CHOICES.map((source) => (
                            <SelectItem key={source} value={source}>
                                {t(PROVIDER_LABELS[source])}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            {webhook.provider === "custom" ? (
                <>
                    <div className="mt-3 space-y-1.5">
                        <Label htmlFor={schemeId}>{t`Signature`}</Label>
                        <Select
                            disabled={isExisting}
                            onValueChange={(value) => {
                                if (isOneOf(CUSTOM_SCHEMES, value)) {
                                    onChange({ ...webhook, scheme: value });
                                }
                            }}
                            value={webhook.scheme}
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
                    <WebhookSigningInstructions scheme={webhook.scheme} />
                    <div className="mt-4">
                        <PayloadFiltersEditor filters={webhook.filters} onChange={(filters) => onChange({ ...webhook, filters })} />
                    </div>
                </>
            ) : (
                <>
                    <div className="mt-3 space-y-1.5">
                        <Label htmlFor={eventId}>{t`Event`}</Label>
                        <Select
                            disabled={isExisting}
                            onValueChange={(value) => {
                                const next = WEBHOOK_PRESET_LIST.find((preset) => preset.provider === webhook.provider && preset.event === value);

                                if (next) {
                                    onChange(next);
                                }
                            }}
                            value={webhook.event}
                        >
                            <SelectTrigger id={eventId}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {WEBHOOK_PRESET_LIST.filter((preset) => preset.provider === webhook.provider).map((preset) => (
                                    <SelectItem key={preset.event} value={preset.event}>
                                        {t(PRESET_EVENT_LABELS[preset.event])}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <p className="text-muted-foreground mt-2">
                        <Trans>The filters and the signature come from the event. Only the provider&apos;s own deliveries for it run.</Trans>
                    </p>
                    <WebhookSigningInstructions scheme={WEBHOOK_PRESETS[webhook.provider].scheme} />
                </>
            )}
        </>
    );
};
