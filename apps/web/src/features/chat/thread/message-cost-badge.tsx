"use client";

import { useLingui } from "@lingui/react/macro";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { CoinsIcon, KeyRoundIcon } from "lucide-react";
import type { FC } from "react";

import type { UIMessage } from "@/lib/agent";

import { formatCostUsd, formatCredits } from "./format-cost";

interface MessageCostBadgeProps {
    cost: NonNullable<UIMessage["cost"]>;
    usage: UIMessage["usage"];
}

/**
 * Gateway cost of an assistant turn, with a token breakdown on hover/focus.
 * BYOK turns were charged to the user's own provider key, not to credits, so the
 * figure is labelled as an estimate of what the provider bills.
 */
const MessageCostBadge: FC<MessageCostBadgeProps> = ({ cost, usage }) => {
    const { i18n, t } = useLingui();
    const amount = formatCostUsd(cost.microdollars);
    // A turn with an unpriced step is a lower bound, not an exact figure.
    const display = cost.pricingAvailable ? amount : `≥${amount}`;
    const Icon = cost.byok ? KeyRoundIcon : CoinsIcon;
    const label = cost.byok ? t`Estimated provider cost ${display}, billed to your own API key` : t`Cost ${display}`;

    const cachedTokens = usage?.cachedInputTokens ?? 0;
    const reasoningTokens = usage?.reasoningTokens ?? 0;

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <button
                        aria-label={label}
                        className="focus-visible:ring-ring flex items-center gap-1 rounded-sm tabular-nums outline-none focus-visible:ring-2"
                        type="button"
                    >
                        <Icon aria-hidden="true" className="size-3 shrink-0" />
                        {display}
                    </button>
                }
            />
            <TooltipContent>
                <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
                    {usage && (
                        <>
                            <dt>{t`Input tokens`}</dt>
                            <dd className="text-right tabular-nums">{formatNumber(usage.promptTokens, i18n.locale)}</dd>
                            {cachedTokens > 0 && (
                                <>
                                    <dt>{t`Cached input`}</dt>
                                    <dd className="text-right tabular-nums">{formatNumber(cachedTokens, i18n.locale)}</dd>
                                </>
                            )}
                            <dt>{t`Output tokens`}</dt>
                            <dd className="text-right tabular-nums">{formatNumber(usage.completionTokens, i18n.locale)}</dd>
                            {reasoningTokens > 0 && (
                                <>
                                    <dt>{t`Reasoning`}</dt>
                                    <dd className="text-right tabular-nums">{formatNumber(reasoningTokens, i18n.locale)}</dd>
                                </>
                            )}
                        </>
                    )}
                    <dt>{cost.byok ? t`Est. provider cost` : t`Cost`}</dt>
                    <dd className="text-right tabular-nums">{display}</dd>
                    {!cost.byok && (
                        <>
                            <dt>{t`Credits`}</dt>
                            <dd className="text-right tabular-nums">{formatCredits(cost.microdollars, i18n.locale)}</dd>
                        </>
                    )}
                </dl>
                {cost.byok && <p className="mt-1">{t`Billed to your own API key, not your credits.`}</p>}
                {!cost.pricingAvailable && <p className="mt-1">{t`Some steps had no pricing data; the total is a minimum.`}</p>}
            </TooltipContent>
        </Tooltip>
    );
};

export default MessageCostBadge;
