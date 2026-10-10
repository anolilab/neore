import { MICRODOLLARS_PER_CREDIT } from "@neore/ai/gateway";

const MICRODOLLARS_PER_DOLLAR = 1_000_000;

/**
 * Format a gateway cost as dollars, with enough precision that a typical
 * single-message cost (fractions of a cent) does not round to "$0.00".
 */
export const formatCostUsd = (microdollars: number): string => {
    if (microdollars <= 0) {
        return "$0.00";
    }

    const dollars = microdollars / MICRODOLLARS_PER_DOLLAR;

    if (dollars < 0.0001) {
        return "<$0.0001";
    }

    if (dollars < 0.01) {
        return `$${dollars.toFixed(4)}`;
    }

    if (dollars < 1) {
        return `$${dollars.toFixed(3)}`;
    }

    return `$${dollars.toFixed(2)}`;
};

/** Credits charged for a cost, to two decimals (credits are fractional). */
export const formatCredits = (microdollars: number, locale: string): string =>
    (microdollars / MICRODOLLARS_PER_CREDIT).toLocaleString(locale, { maximumFractionDigits: 2 });
