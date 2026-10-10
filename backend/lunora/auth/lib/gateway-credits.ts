import type { BillingMode } from "@neore/ai/gateway";
import { DEFAULT_BYOK_FEE_RATE, MICRODOLLARS_PER_CREDIT } from "@neore/ai/gateway";
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import type { Doc } from "../../_generated/dataModel";

/**
 * `BillingMode` as a validator. Spelled out as literals because codegen cannot
 * resolve a union built by a call (`BILLING_MODES.map(v.literal)`); use it
 * through `v.from(...)`. `schema.ts` spells the same union inline on
 * `gatewayUsageDeductions.billingMode` — codegen reads table columns only as
 * written there — and both are pinned to the contract below.
 */
export const vBillingMode = v.union(v.literal("platform"), v.literal("byok"), v.literal("custom"));

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const validatorMatchesContract: Equal<Infer<typeof vBillingMode>, BillingMode> = true;
const columnMatchesContract: Equal<Doc<"gatewayUsageDeductions">["billingMode"], BillingMode | undefined> = true;

// eslint-disable-next-line sonarjs/void-use -- type-level assertions; `void` only marks the bindings as used.
void [validatorMatchesContract, columnMatchesContract];

const isValidRate = (rate: unknown): rate is number => typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1;

/**
 * Credits to deduct for one gateway-reported model call.
 *
 * The gateway sends the call's full model cost plus an explicit `billingMode`
 * (the contract is `@neore/ai/gateway`):
 * - `platform` (or absent, from an older gateway): the platform's key paid, so the full cost is charged;
 * - `byok`: the user's own key paid, so only the platform fee, `byokFeeRate` of the cost, is charged;
 * - `custom`: a user's own endpoint, never charged.
 *
 * 1 credit = 1,000 microdollars, rounded up per call.
 */
export const computeGatewayCredits = ({
    billingMode = "platform",
    byokFeeRate,
    costMicrodollars,
}: {
    billingMode?: BillingMode;
    byokFeeRate?: number;
    costMicrodollars: number;
}): number => {
    if (!Number.isFinite(costMicrodollars) || costMicrodollars <= 0 || billingMode === "custom") {
        return 0;
    }

    if (billingMode === "byok") {
        let rate = DEFAULT_BYOK_FEE_RATE;

        if (isValidRate(byokFeeRate)) {
            rate = byokFeeRate;
        } else if (byokFeeRate !== undefined) {
            console.error(`[billing] Invalid byokFeeRate ${String(byokFeeRate)} in usage report; using ${DEFAULT_BYOK_FEE_RATE}`);
        }

        return Math.ceil((costMicrodollars * rate) / MICRODOLLARS_PER_CREDIT);
    }

    return Math.ceil(costMicrodollars / MICRODOLLARS_PER_CREDIT);
};
