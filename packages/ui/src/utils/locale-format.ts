/**
 * Dates and numbers in the APP's locale. A bare `toLocaleString()` /
 * `new Intl.DateTimeFormat()` follows the BROWSER's language, so a German UI
 * on an English browser showed English dates. Pass the active Lingui locale
 * (`useLingui().i18n.locale`). Each helper keeps the defaults of the
 * `toLocale*` method it replaces, so `formatDate(x, locale)` is
 * `new Date(x).toLocaleDateString(locale)`.
 */
type DateInput = Date | number | string;

const toDate = (value: DateInput): Date => (value instanceof Date ? value : new Date(value));

/** A date without the time — `toLocaleDateString`. */
export const formatDate = (value: DateInput, locale: string, options?: Intl.DateTimeFormatOptions): string => toDate(value).toLocaleDateString(locale, options);

/** A date with the time — `toLocaleString`. */
export const formatDateTime = (value: DateInput, locale: string, options?: Intl.DateTimeFormatOptions): string => toDate(value).toLocaleString(locale, options);

/** The time of day — `toLocaleTimeString`. */
export const formatTime = (value: DateInput, locale: string, options?: Intl.DateTimeFormatOptions): string => toDate(value).toLocaleTimeString(locale, options);

/** A number with the locale's grouping and decimal separators — `toLocaleString`. */
export const formatNumber = (value: number, locale: string, options?: Intl.NumberFormatOptions): string => value.toLocaleString(locale, options);
