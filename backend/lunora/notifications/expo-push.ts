/**
 * Expo's push API: send messages, then read their receipts. Every request carries
 * the access token (push security on), so a leaked phone token alone cannot be
 * used to push to our users. Runs only inside actions: these are external calls.
 *
 * A message never carries a thread or run title (`native-push.ts` builds them):
 * the generic text and opaque ids are all Expo, Apple and Google ever see.
 */
import { fetchWithDeadline } from "../lib/fetch-timeout";

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

/** Expo takes at most 100 messages per send request and 1000 ids per receipt request. */
const SEND_BATCH = 100;
const RECEIPT_BATCH = 1000;

const TIMEOUT_MS = 10_000;

export interface ExpoMessage {
    body?: string;
    /** Opaque ids only. */
    data: Record<string, string>;
    /** iOS: the Notification Service Extension may rewrite the alert before it shows. */
    mutableContent?: boolean;
    priority: "high" | "normal";
    sound?: "default";
    title?: string;
    to: string;
    /** Seconds a push service keeps an undelivered message. */
    ttl: number;
}

/** Expo's answer per message: `ok` with an id to read the receipt by, or an error (`details.error` is the code). */
export type ExpoOutcome = { error?: string; message: string; status: "error" } | { id?: string; status: "ok" };

const errorOf = (value: { details?: { error?: unknown }; id?: unknown; message?: unknown; status?: unknown }): ExpoOutcome => {
    if (value.status === "ok") {
        return { status: "ok", ...(typeof value.id === "string" && { id: value.id }) };
    }

    return {
        message: typeof value.message === "string" ? value.message : "Unknown push error",
        status: "error",
        ...(typeof value.details?.error === "string" && { error: value.details.error }),
    };
};

const post = async (url: string, accessToken: string, body: unknown): Promise<unknown> => {
    const response = await fetchWithDeadline(url, {
        body: JSON.stringify(body),
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        method: "POST",
        timeoutMs: TIMEOUT_MS,
    });

    if (!response.ok) {
        await response.body?.cancel();

        throw new Error(`Expo push API answered ${String(response.status)}`);
    }

    return ((await response.json()) as { data?: unknown }).data;
};

const chunk = <T>(items: T[], size: number): T[][] =>
    Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/** One outcome per message, in order. Throws when Expo cannot be reached or refuses the request as a whole. */
export const sendExpoMessages = async (accessToken: string, messages: ExpoMessage[]): Promise<ExpoOutcome[]> => {
    const outcomes: ExpoOutcome[] = [];

    for (const batch of chunk(messages, SEND_BATCH)) {
        const tickets = await post(EXPO_SEND_URL, accessToken, batch);

        if (!Array.isArray(tickets) || tickets.length !== batch.length) {
            throw new TypeError("Expo push API answered without one ticket per message");
        }

        outcomes.push(...tickets.map((ticket) => errorOf((ticket ?? {}) as Parameters<typeof errorOf>[0])));
    }

    return outcomes;
};

/** The receipts Expo has for these ids. An id with no receipt yet is simply absent. */
export const getExpoReceipts = async (accessToken: string, ids: string[]): Promise<Record<string, ExpoOutcome>> => {
    const receipts: Record<string, ExpoOutcome> = {};

    for (const batch of chunk(ids, RECEIPT_BATCH)) {
        const data = await post(EXPO_RECEIPTS_URL, accessToken, { ids: batch });

        const entries = Object.entries((data ?? {}) as Record<string, unknown>);

        for (const [id, receipt] of entries) {
            receipts[id] = errorOf((receipt ?? {}) as Parameters<typeof errorOf>[0]);
        }
    }

    return receipts;
};

/** The one error that means the phone will never take a push again; the row is deleted only for this. */
export const isDeviceGone = (outcome: ExpoOutcome | undefined): boolean => outcome?.status === "error" && outcome.error === "DeviceNotRegistered";
