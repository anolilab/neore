/**
 * Provider presets for webhook triggers.
 *
 * A preset is a provider plus one of its events. It compiles to the payload
 * filters that select that event (`filters.ts`) and to the signature scheme the
 * provider signs with (`http.ts`). Nothing about a preset is stored: the trigger
 * keeps the filters and the scheme, exactly as a hand-written trigger does.
 *
 * Pure and import-free (type-only), so the web form reads the same tables through
 * `@neore/backend/triggers/presets`.
 *
 * Each filter is checked against the provider's documented payload shape. Where
 * the filter grammar cannot tell an event apart from a neighbouring one, the
 * event is left out rather than approximated.
 */
import type { PayloadFilter } from "./filters";

/**
 * How a webhook delivery is signed. `timestamped` and `native` are ours and
 * GitHub's; `gitlab-token` is GitLab's plain secret header; `linear` is Linear's
 * bare-hex HMAC with a signed `webhookTimestamp` in the body. Absent on a row
 * means "timestamped".
 */
export type WebhookSignatureScheme = "gitlab-token" | "linear" | "native" | "timestamped";

export const WEBHOOK_PROVIDERS = ["github", "gitlab"] as const;

export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

/** The events each provider offers, in the order the form lists them. */
export const PRESET_EVENTS = {
    github: ["pull_request_opened", "pull_request_merged", "pull_request_review_requested", "issue_assigned"],
    gitlab: ["merge_request_opened", "merge_request_merged"],
} as const satisfies Record<WebhookProvider, ReadonlyArray<string>>;

export type WebhookPresetEvent = (typeof PRESET_EVENTS)[WebhookProvider][number];

/** The scheme each provider signs with. */
export const PROVIDER_SCHEME: Record<WebhookProvider, WebhookSignatureScheme> = {
    github: "native",
    gitlab: "gitlab-token",
};

/**
 * The filters that select each event.
 *
 * GitHub sends the event name in `X-GitHub-Event`, which a payload filter cannot
 * read, so each event is identified by the body shape only. `pull_request` and
 * `issues` payloads never share a top-level key (`pull_request` vs `issue`), and
 * the `action` values used here are unique to the event named.
 */
const PRESET_FILTERS: Record<WebhookPresetEvent, ReadonlyArray<PayloadFilter>> = {
    issue_assigned: [
        { op: "equals", path: "action", value: "assigned" },
        { op: "exists", path: "issue" },
    ],
    merge_request_merged: [
        { op: "equals", path: "object_kind", value: "merge_request" },
        { op: "equals", path: "object_attributes.action", value: "merge" },
    ],
    merge_request_opened: [
        { op: "equals", path: "object_kind", value: "merge_request" },
        { op: "equals", path: "object_attributes.action", value: "open" },
    ],
    pull_request_merged: [
        { op: "equals", path: "action", value: "closed" },
        { op: "equals", path: "pull_request.merged", value: "true" },
    ],
    pull_request_opened: [
        { op: "equals", path: "action", value: "opened" },
        { op: "exists", path: "pull_request" },
    ],
    pull_request_review_requested: [
        { op: "equals", path: "action", value: "review_requested" },
        { op: "exists", path: "pull_request" },
    ],
};

export interface WebhookPreset {
    event: WebhookPresetEvent;
    provider: WebhookProvider;
}

/** The events a provider offers, for the form. */
export const presetEventsOf = (provider: WebhookProvider): WebhookPresetEvent[] => [...PRESET_EVENTS[provider]];

/**
 * What a preset compiles to, or `undefined` when the event does not belong to
 * the provider. The caller refuses `undefined`: a preset that names a provider
 * and an event of another provider is a mistake, not a default.
 */
export const compileWebhookPreset = (preset: WebhookPreset): { filters: PayloadFilter[]; scheme: WebhookSignatureScheme } | undefined => {
    if (!(PRESET_EVENTS[preset.provider] as ReadonlyArray<string>).includes(preset.event)) {
        return undefined;
    }

    return {
        filters: PRESET_FILTERS[preset.event].map((filter) => {
            return { ...filter };
        }),
        scheme: PROVIDER_SCHEME[preset.provider],
    };
};
