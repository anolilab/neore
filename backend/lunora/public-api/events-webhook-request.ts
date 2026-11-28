/**
 * The live callback request for Events webhooks: `requestCheckedHttps` with the Workers socket and the DNS-over-HTTPS fetch. Both
 * the subscribe handshake and the delivery sender use it, so every callback POST has its address checked at connect time.
 */
import { requestCheckedHttps } from "../lib/egress";
import { runWebhookConnect } from "../run-webhooks/socket";
import { type CallbackRequest, DELIVERY_TIMEOUT_MS } from "./events-webhook-wire";

/**
 * Every callback POST, the subscribe-time verification included. The address is resolved over DNS-over-HTTPS and refused unless
 * every answer is public; the socket then connects by host name and starts TLS with no options (`connect` in `lib/egress.ts`).
 * The runtime resolves the name again at connect time, so the check is an early refusal and the connection is not pinned to the
 * checked address: an answer that changes between the two lookups is not caught.
 *
 * What is left, stated plainly: (1) the DoH answer is trusted as the resolver's word; (2) the live socket path is tested only with
 * fake sockets, so it must be exercised against a real callback on a dev run before it is relied on; (3) a host whose answers
 * mix public and private addresses is refused, not connected to.
 */
export const liveCallbackRequest: CallbackRequest = async (url, input) =>
    await requestCheckedHttps(
        { body: input.body, headers: input.headers, timeoutMs: DELIVERY_TIMEOUT_MS, url },
        { connect: runWebhookConnect, fetch: async (target, init) => await fetch(target, init) },
    );
