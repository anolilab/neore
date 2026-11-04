/**
 * A cost an agent reported, as money in the person's language. Agents report cumulative costs that are often fractions of a
 * cent, which the currency's own digits would round to zero, so an amount below a cent keeps two significant digits. A
 * currency code the platform does not know is shown as the bare number, never as an error.
 */
export const formatReportedCost = (cost: { amount: number; currency: string }, locale: string | undefined): string => {
    try {
        const digits = cost.amount > 0 && cost.amount < 0.01 ? { maximumSignificantDigits: 2 } : {};

        return new Intl.NumberFormat(locale, { currency: cost.currency, style: "currency", ...digits }).format(cost.amount);
    } catch {
        return `${cost.amount} ${cost.currency}`;
    }
};
