/**
 * Provider presets for webhook triggers.
 *
 * A preset is a provider plus one of its events. It compiles to the payload
 * filters that select that event (`filters.ts`) and to the signature scheme the
 * provider signs with (`http.ts`). Nothing about a preset is stored: the trigger
 * keeps the filters and the scheme, exactly as a hand-written trigger does.
 *
 * Pure and free of runtime imports, so the web form reads the same table through
 * `@neore/backend/triggers/presets`.
 *
 * Each filter is checked against the provider's documented payload shape. Where
 * the filter grammar cannot tell an event apart from a neighbouring one, the
 * event is left out rather than approximated.
 */
import type { PayloadFilter } from "./filters";
import type { WebhookSignatureScheme } from "./validators";

export type { WebhookSignatureScheme } from "./validators";

/**
 * The providers, their signature scheme and their events, in the order the form
 * lists them. Adding a provider here is all the table needs; `createTrigger`'s
 * `webhookPreset` validator must follow (a compile-time check there says so).
 *
 * GitHub sends the event name in `X-GitHub-Event`, which a payload filter cannot
 * read, so each of its events is identified by the body shape only. `pull_request`
 * and `issues` payloads never share a top-level key (`pull_request` vs `issue`),
 * and the `action` values used here are unique to the event named.
 */
export const WEBHOOK_PRESETS = {
    github: {
        events: [
            {
                filters: [
                    { op: "equals", path: "action", value: "opened" },
                    { op: "exists", path: "pull_request" },
                ],
                id: "pull_request_opened",
            },
            {
                filters: [
                    { op: "equals", path: "action", value: "closed" },
                    { op: "equals", path: "pull_request.merged", value: "true" },
                ],
                id: "pull_request_merged",
            },
            {
                filters: [
                    { op: "equals", path: "action", value: "review_requested" },
                    { op: "exists", path: "pull_request" },
                ],
                id: "pull_request_review_requested",
            },
            {
                filters: [
                    { op: "equals", path: "action", value: "assigned" },
                    { op: "exists", path: "issue" },
                ],
                id: "issue_assigned",
            },
        ],
        scheme: "native",
    },
    gitlab: {
        events: [
            {
                filters: [
                    { op: "equals", path: "object_kind", value: "merge_request" },
                    { op: "equals", path: "object_attributes.action", value: "open" },
                ],
                id: "merge_request_opened",
            },
            {
                filters: [
                    { op: "equals", path: "object_kind", value: "merge_request" },
                    { op: "equals", path: "object_attributes.action", value: "merge" },
                ],
                id: "merge_request_merged",
            },
        ],
        scheme: "gitlab-token",
    },
} as const satisfies Record<string, { events: ReadonlyArray<{ filters: ReadonlyArray<PayloadFilter>; id: string }>; scheme: WebhookSignatureScheme }>;

export type WebhookProvider = keyof typeof WEBHOOK_PRESETS;

export const WEBHOOK_PROVIDERS = Object.keys(WEBHOOK_PRESETS) as WebhookProvider[];

type EventOf<P extends WebhookProvider> = (typeof WEBHOOK_PRESETS)[P]["events"][number]["id"];

/** A provider and one of ITS events: a mismatched pair is not a value of this type. */
export type WebhookPreset = { [P in WebhookProvider]: { event: EventOf<P>; provider: P } }[WebhookProvider];

export type WebhookPresetEvent = WebhookPreset["event"];

const presetsOf = <P extends WebhookProvider>(provider: P): ReadonlyArray<{ event: EventOf<P>; provider: P }> =>
    WEBHOOK_PRESETS[provider].events.map((event) => {
        return { event: event.id, provider };
    });

/** Every preset, in the order the form lists them. A provider missing from the left side fails to compile. */
const PRESETS_BY_PROVIDER: { [P in WebhookProvider]: ReadonlyArray<{ event: EventOf<P>; provider: P }> } = {
    github: presetsOf("github"),
    gitlab: presetsOf("gitlab"),
};

export const WEBHOOK_PRESET_LIST: ReadonlyArray<WebhookPreset> = WEBHOOK_PROVIDERS.flatMap(
    (provider): ReadonlyArray<WebhookPreset> => PRESETS_BY_PROVIDER[provider],
);

/**
 * What a preset compiles to: the filters that select its event and the provider's
 * signature scheme. An event that is not the provider's cannot be built as a
 * `WebhookPreset`, and `createTrigger` validates the same pairs, so the throw is
 * unreachable; it is there because an empty filter set would accept every delivery.
 */
export const compileWebhookPreset = (preset: WebhookPreset): { filters: PayloadFilter[]; scheme: WebhookSignatureScheme } => {
    const { events, scheme } = WEBHOOK_PRESETS[preset.provider];
    const found = events.find((event) => event.id === preset.event);

    if (!found) {
        throw new Error(`No ${preset.provider} preset for ${preset.event}`);
    }

    return {
        filters: found.filters.map((filter) => {
            return { ...filter };
        }),
        scheme,
    };
};
