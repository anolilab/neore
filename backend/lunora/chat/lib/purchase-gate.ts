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
    /\b(?:pay|buy|purchase|checkout)\b/iu,
    /\b(?:place|complete|confirm|submit) (?:your )?(?:order|purchase)\b/iu,
    /\border now\b/iu,
    /\b(?:confirm|submit|complete|make|proceed to|continue to) (?:the )?payment\b/iu,
    /\b(?:bezahlen|bezahle|kaufen|kaufe|bestellen|bestelle)\b/iu,
    /\bjetzt (?:zahlen|zahle|bezahlen)\b/iu,
    // The end is a letter or digit look-ahead, not \b: \b does not follow "ß" at the end of a string, so it would never match.
    /\bbestellung (?:aufgeben|abschicken|absenden|abschließen)(?![\p{L}\p{N}])/iu,
    /\bkauf abschließen(?![\p{L}\p{N}])/iu,
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
    /** The element is on a checkout (a form with card fields, or a checkout page): a submit-like label there asks. */
    checkout?: boolean;
    content?: string;
    /** Why the read failed, when it did (`Element not found: …` for a selector that matches nothing). */
    error?: string;
    /** The control's accessible name (aria-label, labelled-by text, title), when it is not its text. */
    label?: string;
    /** The renderer cut the accessible name short: a purchase word may sit past the cut, so the gate cannot clear it. */
    labelTruncated?: boolean;
    /** One of the control's name sources is exactly a submit word (the renderer's check on each name part). */
    submitLike?: boolean;
    /** One of the control's name sources is exactly a bare subscription word (the renderer's check on each name part). */
    subscribeLike?: boolean;
    success: boolean;
    /** The renderer cut the text short: a purchase word may sit past the cut, so the gate cannot clear it. */
    truncated?: boolean;
}

/**
 * Whether a browser action needs the person's yes before it runs. Only a click reads a target. Anything else, and a click
 * with no selector (an empty one too: the renderer reads "" as no selector), asks nothing: the action itself refuses or fails.
 */
export const browserActionNeedsPurchaseApproval = async (
    input: { action: string; selector?: string },
    look: (selector: string) => Promise<ClickTargetLook>,
): Promise<boolean> => {
    if (input.action !== "click" || !input.selector) {
        return false;
    }

    try {
        const target = await look(input.selector);

        // A look that failed (a selector that matches nothing, a person in control, a closed session) asks nothing: the click is
        // refused when it runs, and `execute` checks a purchase itself. A card would approve a click that cannot run.
        if (target.error !== undefined) {
            return false;
        }

        return purchaseTargetNeedsApproval(target);
    } catch {
        return true;
    }
};

/** Words a checkout's own submit button carries when it has no purchase word of its own (English and German). */
// The whole label must be the word (the labels are trimmed before this): "Continue shopping" is navigation, not the payment.
/** A bare "Subscribe" or "Abonnieren": a paid signup or a newsletter, so it asks on any page (not only a checkout). */
const SUBSCRIBE_WORD = /^(?:subscribe|abonnieren)[.!]?$/iu;

const CHECKOUT_SUBMIT_WORDS: ReadonlyArray<RegExp> = [/^(?:confirm|submit|continue|complete|place|subscribe|weiter|bestätigen|absenden|abonnieren)[.!]?$/iu];

/** Whether one read of a click's target asks the person first. A read that failed, or was cut short, asks. */
export const purchaseTargetNeedsApproval = (target: ClickTargetLook): boolean => {
    if (target.success !== true || target.truncated === true || target.labelTruncated === true) {
        return true;
    }

    // A control with neither text nor a name (an icon button with no aria-label, title or value) has nothing the gate can
    // read, so it asks: the selector says nothing about what the click does. A control with an ordinary name asks only
    // when a purchase word is in its text or its name: an arrow icon with aria-label "Buy now" asks.
    const text = target.content?.trim() ?? "";
    const name = target.label?.trim() ?? "";

    // On a checkout a bare "Confirm", "Submit" or "Continue" is the payment itself: the same words elsewhere are not. The
    // name is joined from several parts ("Continue shopping Confirm"), so the renderer also reports a part that is one.
    const submitsOnCheckout =
        target.checkout === true && (target.submitLike === true || [text, name].some((part) => CHECKOUT_SUBMIT_WORDS.some((pattern) => pattern.test(part))));

    // A bare "Subscribe" (a paid signup, or a newsletter's) asks on any page: a paid one must not run unapproved where no checkout is recognized.
    // The renderer reports it per name part, so a name joined with another part ("Subscribe Monthly plan") still counts.
    const isBareSubscribe = target.subscribeLike === true || [text, name].some((part) => SUBSCRIBE_WORD.test(part.trim()));

    return (text === "" && name === "") || isPurchaseText(text) || isPurchaseText(name) || isBareSubscribe || submitsOnCheckout;
};

/**
 * The tool calls the person approved in a conversation: an approval request names its tool call, and an approval response
 * with `approved: true` answers it. The SDK runs an approved call with the messages that hold both, so a tool's `execute`
 * reads its own call's answer here.
 */
export const approvedToolCallIds = (messages: ReadonlyArray<unknown> = []): Set<string> => {
    const partsOf = (message: unknown): ReadonlyArray<Record<string, unknown>> => {
        const content = typeof message === "object" && message !== null ? (message as { content?: unknown }).content : undefined;

        return Array.isArray(content) ? content.filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null) : [];
    };
    const parts = messages.flatMap((message) => partsOf(message));
    const callByApproval = new Map<string, string>();

    for (const part of parts) {
        if (part.type === "tool-approval-request" && typeof part.approvalId === "string" && typeof part.toolCallId === "string") {
            callByApproval.set(part.approvalId, part.toolCallId);
        }
    }

    const approved = new Set<string>();

    for (const part of parts) {
        if (!(part.type === "tool-approval-response" && part.approved === true && typeof part.approvalId === "string")) {
            continue;
        }

        const toolCallId = callByApproval.get(part.approvalId);

        if (toolCallId !== undefined) {
            approved.add(toolCallId);
        }
    }

    return approved;
};
