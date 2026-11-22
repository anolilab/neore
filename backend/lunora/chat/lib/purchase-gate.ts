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
    /\b(?:confirm|submit|complete|make|proceed to|continue to) (?:the )?payment\b/iu,
    /\b(?:bezahlen|bezahle|kaufen|kaufe|bestellen|bestelle)\b/iu,
    /\b(?:zahlen|zahle)\b/iu,
    /\bbestellung (?:aufgeben|abschicken|absenden|abschließen)\b/iu,
    /\bkauf abschließen\b/iu,
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
    /** The control's accessible name (aria-label, labelled-by text, title), when it is not its text. */
    label?: string;
    /** The renderer cut the accessible name short: a purchase word may sit past the cut, so the gate cannot clear it. */
    labelTruncated?: boolean;
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

        if (target.success !== true || target.truncated === true || target.labelTruncated === true) {
            return true;
        }

        // A control with neither text nor a name (an icon button with no aria-label, title or value) has nothing the gate can
        // read, so it asks: the selector says nothing about what the click does. A control with an ordinary name asks only
        // when a purchase word is in its text or its name: an arrow icon with aria-label "Buy now" asks.
        const text = target.content?.trim() ?? "";
        const name = target.label?.trim() ?? "";

        return (text === "" && name === "") || isPurchaseText(text) || isPurchaseText(name);
    } catch {
        return true;
    }
};
