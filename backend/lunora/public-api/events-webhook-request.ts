/**
 * The live callback request for Events webhooks: `requestCheckedHttps` with the Workers socket and the DNS-over-HTTPS fetch. Both
 * the subscribe handshake and the delivery sender use it, so every callback POST has its address checked at connect time.
 */
import { requestCheckedHttps } from "../lib/egress";
import { runWebhookConnect } from "../run-webhooks/socket";
import { type CallbackRequest, DELIVERY_TIMEOUT_MS } from "./events-webhook-wire";

export const liveCallbackRequest: CallbackRequest = async (url, input) =>
    await requestCheckedHttps(
        { body: input.body, headers: input.headers, timeoutMs: DELIVERY_TIMEOUT_MS, url },
        { connect: runWebhookConnect, fetch: async (target, init) => await fetch(target, init) },
    );
