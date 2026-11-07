const SMALL_AMOUNT_DIGITS = { maximumSignificantDigits: 2 } as const;

/** An amount below one minor unit keeps two significant digits; the currency's own digits would round it to zero. */
const digitsFor = (amount: number, minorUnit: number): { maximumSignificantDigits?: number } => (amount > 0 && amount < minorUnit ? SMALL_AMOUNT_DIGITS : {});

/**
 * A cost an agent reported, as money in the person's language. Agents report cumulative costs that are often fractions of a
 * minor unit (a cent, or a whole yen), which the currency's own digits would round to zero, so such an amount keeps two
 * significant digits. A currency code the platform does not know is shown as the bare number, never as an error.
 */
export const formatReportedCost = (cost: { amount: number; currency: string }, locale: string | undefined): string => {
    try {
        const currencyOptions = { currency: cost.currency, style: "currency" } as const;
        // The currency's own digits: a yen has none, a dollar two. The platform's default is two when it does not say.
        const fractionDigits = new Intl.NumberFormat(locale, currencyOptions).resolvedOptions().maximumFractionDigits ?? 2;
        const minorUnit = 10 ** -fractionDigits;

        return new Intl.NumberFormat(locale, { ...currencyOptions, ...digitsFor(cost.amount, minorUnit) }).format(cost.amount);
    } catch {
        return `${new Intl.NumberFormat(locale, digitsFor(cost.amount, 0.01)).format(cost.amount)} ${cost.currency}`;
    }
};
