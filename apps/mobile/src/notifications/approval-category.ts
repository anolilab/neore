/**
 * The approval category the phone registers, without the device API: its actions, and the call that registers them through a
 * setter it is given. `approval-actions.ts` passes the real one.
 */
import { APPROVE_ACTION, DENY_ACTION, TOOL_APPROVAL_CATEGORY } from "./approval-response";

export interface ApprovalAction {
    buttonTitle: string;
    identifier: string;
    options: { isAuthenticationRequired: boolean; isDestructive?: boolean; opensAppToForeground: boolean };
}

/** Button titles per language, in the same locales as the rest of the phone's own text. English is the fallback. */
const ACTION_TITLES: Readonly<Record<string, { approve: string; deny: string }>> = {
    de: { approve: "Genehmigen", deny: "Ablehnen" },
    en: { approve: "Approve", deny: "Deny" },
    es: { approve: "Aprobar", deny: "Rechazar" },
    fr: { approve: "Approuver", deny: "Refuser" },
    it: { approve: "Approva", deny: "Nega" },
    ja: { approve: "承認", deny: "拒否" },
    pl: { approve: "Zatwierdź", deny: "Odrzuć" },
    pt: { approve: "Aprovar", deny: "Recusar" },
    zh: { approve: "批准", deny: "拒绝" },
    // Traditional script, and the regions that use it: a region or script tag is looked up before the base language.
    "zh-hant": { approve: "批准", deny: "拒絕" },
    "zh-hk": { approve: "批准", deny: "拒絕" },
    "zh-mo": { approve: "批准", deny: "拒絕" },
    "zh-tw": { approve: "批准", deny: "拒絕" },
};

const LOCALE_SEPARATOR = /[-_]/u;

/** The table entry for the most specific tag the phone's locale names that has one: `zh-Hant-TW`, then `zh-Hant`, then `zh`. */
const titlesFor = (locale: string | undefined): (typeof ACTION_TITLES)[string] => {
    const parts = (locale ?? "").toLowerCase().split(LOCALE_SEPARATOR);
    // Longest first: `zh-hant-tw`, `zh-hant`, `zh`.
    const candidates = parts.map((_part, index) => parts.slice(0, index + 1).join("-")).toReversed();
    // Own keys only: a language such as `constructor` must not read an inherited property.
    const tag = candidates.find((candidate) => Object.hasOwn(ACTION_TITLES, candidate));

    return (tag === undefined ? ACTION_TITLES.en : ACTION_TITLES[tag]) as (typeof ACTION_TITLES)[string];
};

/**
 * The actions a tool approval's alert carries, titled in the phone's language. Each one is answered only after the device is unlocked
 * (`isAuthenticationRequired`), so an alert read on a locked phone cannot submit an approval. Each opens the app, so the answer is
 * read there (`approval-tap-listener.ts`) even when the app was closed: a tap is never dropped.
 */
export const approvalActionsFor = (locale: string | undefined): ApprovalAction[] => {
    const titles = titlesFor(locale);

    return [
        { buttonTitle: titles.approve, identifier: APPROVE_ACTION, options: { isAuthenticationRequired: true, opensAppToForeground: true } },
        {
            buttonTitle: titles.deny,
            identifier: DENY_ACTION,
            options: { isAuthenticationRequired: true, isDestructive: true, opensAppToForeground: true },
        },
    ];
};

/** Registers the approval category through `setCategory`, with a fresh copy of the actions. A failure reaches the caller to retry. */
export const registerApprovalActionsWith = async (
    setCategory: (identifier: string, actions: ApprovalAction[]) => Promise<unknown>,
    locale?: string,
): Promise<void> => {
    await setCategory(TOOL_APPROVAL_CATEGORY, approvalActionsFor(locale));
};
