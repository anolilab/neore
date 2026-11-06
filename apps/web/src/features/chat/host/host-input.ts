/**
 * The most characters the host composer keeps in its draft before any cleaning, for a send limit of `sendLimit`. Hidden
 * characters can make a paste much longer than the text a person sees, so this allows several times the send limit; a
 * paste beyond it is refused rather than scanned in full on every keystroke.
 */
const RAW_LIMIT_FACTOR = 4;

/** Whether a value the textarea reports is too long to clean and keep. */
export const exceedsRawInputLimit = (value: string, sendLimit: number): boolean => value.length > sendLimit * RAW_LIMIT_FACTOR;
