/**
 * The Workers socket API, handed to `postCheckedHttps` (`lib/egress.ts`).
 *
 * Only this file imports `cloudflare:sockets`; Vitest maps it to a stub
 * (`vitest.config.ts`), so delivery tests inject their own connect function.
 */
import { connect } from "cloudflare:sockets";

import type { EgressConnect } from "../lib/egress";

export const runWebhookConnect: EgressConnect = connect;
