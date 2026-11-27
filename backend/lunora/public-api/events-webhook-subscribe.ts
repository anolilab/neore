/**
 * `events/subscribe` and `events/unsubscribe` as the router runs them. This is an HTTP action, so the outbound DNS lookup sits
 * here and not in a mutation. The store writes go to the key owner's shard through internal functions.
 *
 * The order is deliberate: the host is checked against the approved list before anything is looked up, so the endpoint does
 * no DNS work for a host the owner has not approved.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import { BETTER_AUTH_SECRET } from "../env";
import { encryptKey } from "../lib/encryption";
import { inShard } from "../lib/http-shard";
import { fromProcedureError } from "./errors";
import { decodeEventCursor, encodeEventCursor } from "./events-cursor";
import {
    CALLBACK_ENDPOINT_ERROR,
    EventsWebhookError,
    FORBIDDEN,
    INVALID_PARAMS,
    MAX_SUBSCRIPTIONS,
    NOT_FOUND,
    RESOURCE_EXHAUSTED,
    type SubscribeRequest,
    type SubscribeResult,
    subscriptionIdOf,
    subscriptionKeyHash,
    type UnsubscribeRequest,
} from "./events-webhook";
import { checkCallbackHost } from "./events-webhook-address";
import type { ApiKeyIdentity } from "./identity";

export const subscribeWebhook = async (lunora: HttpActionCtx, identity: ApiKeyIdentity, request: SubscribeRequest): Promise<SubscribeResult> => {
    const { userId } = identity;
    const { approved } = await inShard(
        lunora,
        userId,
        async (ctx) => await ctx.runQuery(internal.auth.event_webhook_hosts.hostApproved, { host: request.host, userId }),
    ).catch((error: unknown) => {
        throw fromProcedureError(error);
    });

    if (!approved) {
        throw new EventsWebhookError(FORBIDDEN, "The callback host is not on this account's approved list.", {
            host: request.host,
            reason: "host_not_approved",
        });
    }

    const address = await checkCallbackHost(request.host);

    if (address === "private") {
        throw new EventsWebhookError(INVALID_PARAMS, "The callback host resolves to a private or reserved address.", { reason: "address_not_public" });
    }

    if (address === "unresolved") {
        throw new EventsWebhookError(CALLBACK_ENDPOINT_ERROR, "The callback host could not be resolved.", { reason: "connection_refused" });
    }

    const cursorSeq = request.cursor === null ? null : await decodeEventCursor(BETTER_AUTH_SECRET, userId, request.cursor);

    if (request.cursor !== null && cursorSeq === null) {
        throw new EventsWebhookError(INVALID_PARAMS, "`cursor` is not one this key was given.");
    }

    const keyHash = await subscriptionKeyHash(identity.apiKeyId, request.url, request.name, request.argumentsKey);
    const id = subscriptionIdOf(keyHash);
    const secretCiphertext = await encryptKey(request.secret, "tool-keys");
    const outcome = await inShard(
        lunora,
        userId,
        async (ctx) =>
            await ctx.runMutation(internal.public_api.event_webhooks.subscribe, {
                argumentsKey: request.argumentsKey,
                ...(cursorSeq !== null && { cursorSeq }),
                grantedTtlMs: request.grantedTtlMs,
                host: request.host,
                id,
                keyHash,
                ...(request.maxAgeMs !== null && { maxAgeMs: request.maxAgeMs }),
                name: request.name,
                principal: identity.apiKeyId,
                secretCiphertext,
                url: request.url,
                userId,
            }),
    ).catch((error: unknown) => {
        throw fromProcedureError(error);
    });

    if (outcome.refusal === "host_not_approved") {
        throw new EventsWebhookError(FORBIDDEN, "The callback host is not on this account's approved list.", {
            host: request.host,
            reason: "host_not_approved",
        });
    }

    if (outcome.refusal === "account_erasing") {
        throw new EventsWebhookError(FORBIDDEN, "This account is being deleted, so it takes no new webhook subscriptions.", {
            reason: "account_erasing",
        });
    }

    if (outcome.refusal === "limit") {
        throw new EventsWebhookError(RESOURCE_EXHAUSTED, "This account has as many webhook subscriptions as it may hold.", {
            limit: "subscriptions",
            max: MAX_SUBSCRIPTIONS,
        });
    }

    return {
        cursor: await encodeEventCursor(BETTER_AUTH_SECRET, userId, outcome.cursorSeq),
        id,
        refreshBefore: new Date(outcome.expiresAt).toISOString(),
        truncated: outcome.truncated,
    };
};

export const unsubscribeWebhook = async (lunora: HttpActionCtx, identity: ApiKeyIdentity, request: UnsubscribeRequest): Promise<void> => {
    const { userId } = identity;
    const keyHash = await subscriptionKeyHash(identity.apiKeyId, request.url, request.name, request.argumentsKey);
    const { found } = await inShard(
        lunora,
        userId,
        async (ctx) => await ctx.runMutation(internal.public_api.event_webhooks.unsubscribe, { keyHash, userId }),
    ).catch((error: unknown) => {
        throw fromProcedureError(error);
    });

    if (!found) {
        throw new EventsWebhookError(NOT_FOUND, "No subscription matches this key.", { kind: "subscription" });
    }
};
