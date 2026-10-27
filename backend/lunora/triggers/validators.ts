/**
 * The webhook signature schemes, declared once: `schema.ts` stores one, the
 * procedures accept and return it, `http.ts` keys its handlers on it and
 * `presets.ts` derives its type from it, so a new scheme cannot reach one and not
 * the others.
 *
 * An inline `v.union(...)` of literals: codegen resolves that, not one built by a call.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

/** How a webhook delivery is signed; see `triggers/http.ts`. Absent on a row means "timestamped". */
export const vWebhookSignatureScheme = v.union(v.literal("timestamped"), v.literal("native"), v.literal("gitlab-token"));

export type WebhookSignatureScheme = Infer<typeof vWebhookSignatureScheme>;
