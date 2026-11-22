/**
 * The purchase gate on browser clicks. A click whose target reads as a purchase ("Pay now", "Buy", "Place order")
 * asks the person first, in every permission mode. The browser tool defaults to `auto`, and a time-boxed allow does not
 * lift an answer the tool gives for the call itself (`withLapse` in `tool-permissions.ts`), so the gate holds in both.
 *
 * The target is read with the same selector the click would use, before the click, so the person is asked about the
 * thing the click would press. A read that errors or finds nothing asks: an unreadable target is never clicked unseen.
 */

/**
 * Phrases that name a purchase on a button or link, English and German. Whole words only, so "payroll" is not "pay" and
 * "Bestellungen" (orders, a noun) is not "bestellen" (to order). Matched on text with its whitespace collapsed, so a line
 * break or a non-breaking space inside a phrase does not hide it.
 */
const PURCHASE_PATTERNS: ReadonlyArray<RegExp> = [
    /\b(?:pay|buy|purchase|checkout|check out)\b/iu,
    /\b(?:place|complete|confirm|submit) (?:your )?(?:order|purchase)\b/iu,
    /\border now\b/iu,
    /\b(?:bezahlen|bezahle|kaufen|kaufe|bestellen|bestelle)\b/iu,
    /\bzur kasse\b/iu,
    /\bzahlungspflichtig\w*\b/iu,
];

export const isPurchaseText = (text: string): boolean => {
    const collapsed = text.replaceAll(/\s+/gu, " ");

    return PURCHASE_PATTERNS.some((pattern) => pattern.test(collapsed));
};

/**
 * What the renderer reports for a read of one element (`extract` with a selector, `visibleOnly`): the text a person sees,
 * as `content`.
 */
export interface ClickTargetLook {
    content?: string;
    success: boolean;
    /** The renderer cut the text short: a purchase word may sit past the cut, so the gate cannot clear it. */
    truncated?: boolean;
}

/**
 * Whether a browser action needs the person's yes before it runs. Only a click reads a target. Anything else, and a click
 * with no selector, asks nothing: the action itself refuses or fails.
 */
export const browserActionNeedsPurchaseApproval = async (
    input: { action: string; selector?: string },
    look: (selector: string) => Promise<ClickTargetLook>,
): Promise<boolean> => {
    if (input.action !== "click" || input.selector === undefined) {
        return false;
    }

    try {
        const target = await look(input.selector);

        if (target.success !== true || target.truncated === true) {
            return true;
        }

        // An element with no text (an icon button, a control named by aria-label or value) has no name the gate can read,
        // so it asks: the selector says nothing about what the click does.
        const text = target.content?.trim() ?? "";

        return text === "" || isPurchaseText(text);
    } catch {
        return true;
    }
};
