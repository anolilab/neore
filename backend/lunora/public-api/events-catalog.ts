/**
 * The Events extension's catalog (SEP-3415): the event types this endpoint offers, their argument and payload schemas, and
 * the argument check `events/poll` runs before it reads anything. Pure, so the dispatcher, the router and the tests share
 * one definition.
 *
 * Every event is offered by poll, and by webhook once `events/subscribe` has a callback for it (`events-webhook.ts`). Push
 * (`events/stream`) is a later part and answers `-32601`.
 *
 * Schema evolution (the spec's rule): a field may be added, never removed, retyped or narrowed, for the life of its name.
 * A breaking change gets a new name.
 */

export const EVENT_EXTENSION_ID = "io.modelcontextprotocol/events";

export const RUN_COMPLETED_EVENT = "run.completed";
export const RUN_FAILED_EVENT = "run.failed";
export const APPROVAL_REQUESTED_EVENT = "approval.requested";

export const EVENT_NAMES = [RUN_COMPLETED_EVENT, RUN_FAILED_EVENT, APPROVAL_REQUESTED_EVENT] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** The `outcome` a `run.completed` / `run.failed` payload carries. Text, so a later outcome can be added without a new type. */
export const RUN_OUTCOME_SUCCEEDED = "succeeded";
export const RUN_OUTCOME_FAILED = "failed";

/** What a `approval.requested` payload's `kind` says the person is asked for. */
export const APPROVAL_KINDS = ["approval", "question", "secret"] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** The longest thread id an argument or payload may carry: a bound on what a client can send, not a format. */
const MAX_ID_LENGTH = 255;

export const DEFAULT_MAX_EVENTS = 50;
export const MAX_EVENTS_LIMIT = 100;

/** Milliseconds a client should wait before the next poll when the last one came back empty. */
export const POLL_INTERVAL_MS = 5000;

type JsonSchema = Record<string, unknown>;

const threadIdArgument: JsonSchema = {
    description: "Only events of this thread.",
    maxLength: MAX_ID_LENGTH,
    minLength: 1,
    type: "string",
};

const eventInputSchema: JsonSchema = {
    additionalProperties: false,
    properties: { threadId: threadIdArgument },
    type: "object",
};

const runPayloadSchema: JsonSchema = {
    properties: {
        finishedAt: { description: "When the run ended, in epoch milliseconds.", type: "integer" },
        outcome: { description: `"${RUN_OUTCOME_SUCCEEDED}" for run.completed, "${RUN_OUTCOME_FAILED}" for run.failed.`, type: "string" },
        threadId: { description: "The chat thread the run belongs to.", type: "string" },
    },
    required: ["threadId", "outcome", "finishedAt"],
    type: "object",
};

const approvalPayloadSchema: JsonSchema = {
    properties: {
        kind: { description: "approval: a tool call; question: an ask-user form; secret: a requested secret.", enum: [...APPROVAL_KINDS], type: "string" },
        requestId: { description: "The approval request's id. Answering it is a tool call, not an event.", type: "string" },
        threadId: { description: "The chat thread that is waiting.", type: "string" },
    },
    required: ["threadId", "requestId", "kind"],
    type: "object",
};

export interface EventDescriptor {
    delivery: ReadonlyArray<"poll" | "webhook">;
    description: string;
    inputSchema: JsonSchema;
    name: EventName;
    payloadSchema: JsonSchema;
}

/** The event types, in the order `events/list` returns them. */
export const EVENT_CATALOG: ReadonlyArray<EventDescriptor> = [
    {
        delivery: ["poll", "webhook"],
        description: "A chat run finished normally.",
        inputSchema: eventInputSchema,
        name: RUN_COMPLETED_EVENT,
        payloadSchema: runPayloadSchema,
    },
    {
        delivery: ["poll", "webhook"],
        description: "A chat run ended with an error.",
        inputSchema: eventInputSchema,
        name: RUN_FAILED_EVENT,
        payloadSchema: runPayloadSchema,
    },
    {
        delivery: ["poll", "webhook"],
        description: "A chat run paused and is waiting for a person to approve, answer or supply something.",
        inputSchema: eventInputSchema,
        name: APPROVAL_REQUESTED_EVENT,
        payloadSchema: approvalPayloadSchema,
    },
];

export const findEvent = (name: unknown): EventDescriptor | undefined =>
    typeof name === "string" ? EVENT_CATALOG.find((descriptor) => descriptor.name === name) : undefined;

export interface EventArguments {
    threadId?: string;
}

/**
 * The subscription arguments the catalog allows, or `null` when they name a property the schema does not declare or give a
 * `threadId` that is not a non-empty string within the bound. `arguments` absent means none.
 */
export const parseEventArguments = (value: unknown): EventArguments | null => {
    if (value === undefined) {
        return {};
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.some(([key]) => key !== "threadId")) {
        return null;
    }

    const { threadId } = value as Record<string, unknown>;

    if (threadId === undefined) {
        return {};
    }

    if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > MAX_ID_LENGTH) {
        return null;
    }

    return { threadId };
};

/** The `events/list` result's event entries. */
export const describeEvents = (): EventDescriptor[] =>
    EVENT_CATALOG.map((descriptor) => {
        return { ...descriptor, delivery: [...descriptor.delivery] };
    });
