/**
 * Where a memory was learned: a short quote of the user's own words and the
 * message they were in, shown in the memory list.
 *
 * The quote is the extractor's claim, so it is kept only when it really is the
 * user's text: a verbatim (whitespace-insensitive) excerpt of what they typed
 * (`chat/lib/attached-text.ts#typedTextOf`). Assistant, tool and attached text
 * never pass that check. Secret-looking quotes are
 * dropped whole; every quote goes through {@link evidenceQuote}, the one place a
 * shared redactor plugs in.
 */

import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { containsSecret } from "../lib/secret-redaction";

/** Longest quote kept, in characters. */
export const EVIDENCE_QUOTE_MAX_CHARS = 200;

/** Shortest quote worth showing. */
const EVIDENCE_QUOTE_MIN_CHARS = 3;

/** Text either side of the quote that is checked with it, so a quoted value cannot shed the label that marks it a secret. */
const EVIDENCE_CONTEXT_CHARS = 60;

const WHITESPACE_RE = /\s+/gu;
const SPACE_RE = /\s/u;

/**
 * Characters that draw nothing (zero-width spaces and joiners, soft hyphens, variation selectors, combining
 * grapheme joiners, tags): dropped for a second look in the secret check, so `pass\u200Bword` still reads as a label.
 */
const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Text that reads as a credential or a card or account number. Conservative on
 * purpose: a false positive only costs the quote, never the memory.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
    // Key prefixes of common providers.
    /\b(?:sk|pk|rk)[-_][\w-]{12,}/iu,
    /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs])[\w-]{10,}/iu,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bAIza[\w-]{30,}/u,
    // JSON Web Tokens.
    /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/u,
    // PEM blocks.
    /-----BEGIN [A-Z ]+-----/u,
    // A login in a URL: `scheme://user:password@host`. Only the shape with a colon before the "@" in the authority, so a
    // plain `https://host/path@tag` or a bare username stays quotable.
    /\b[a-z][a-z\d+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]+@/iu,
    // The same login cut off before its "@" (the quote ends inside the password): a colon after the host that is not a
    // port (a port is digits), so the check does not need the "@" within reach of the quote's window.
    /\b[a-z][a-z\d+.-]*:\/\/[^\s/?#@:]*:(?=\S)(?!\d)/iu,
    // A secret-looking query parameter (`?password=`, `&access_token=`, `?api_key=`, `&sig=`): the name ends the key, so
    // `page=2` or `sort=asc` stay quotable.
    /[?&][\w.-]*(?:pass(?:word|wd)?|pwd|token|secret|api[_-]?key|sig(?:nature)?)=/iu,
    // Any mention of one, with or without a value next to it: a false positive only costs the quote.
    /\b(?:pass(?:word|wd|code|phrase|port)|pwd?|pins?|passw[oö]rt|kennwort|kennung)\b/iu,
    // A credential word glued to a word before it ("mypassword is …"): with the invisible characters dropped, no
    // boundary is left before it, so the value marker after it is what marks it.
    /(?:pass(?:word|wd|code|phrase)|passw[oö]rt|kennwort)\s*(?:is\b|:|=)\s*\S/iu,
    /\b(?:secrets?|tokens?|ssn|iban|cvv|cvc|cards?)\b/iu,
    // HTTP credentials: the Authorization header and the Bearer scheme, whatever the value looks like (an all-letter
    // token too). Not "basic" on its own: too common a word; a Basic value inside the header is caught by "authorization".
    /\b(?:authori[sz]ation|bearer)\b/iu,
    // Cookie and session headers or assignments; the ":" or "=" keeps "cookie recipe" or "a long session" quotable.
    /\b(?:set-)?cookie\s*[:=]|\b(?:session(?:[\s_-]?id)?|sid|auth)\s*[:=]/iu,
    /\b(?:(?:api|private)[\s_-]?)?keys?\b/iu,
    /\b(?:card|account|social security|routing)[\s_-]?(?:number|no)\b/iu,
    // The same labels in the other languages the app ships in (German above).
    /\b(?:mot de passe|code pin|code secret|contrase[ñn]a|clave|senha|has[łl]o)\b/iu,
    /\b(?:num[ée]ro de (?:carte|compte)|n[úu]mero d[aeo] (?:tarjeta|cuenta|cart[ãa]o|conta)|numer (?:karty|konta))\b/iu,
    /\bnumero (?:di|del|della) (?:carta|conto)\b/iu,
    // Portuguese bank and card labels the pattern above does not cover ("conta bancária", "cartão de crédito").
    /\b(?:conta banc[áa]ria|dados banc[áa]rios|c[óo]digo de seguran[çc]a|cart[ãa]o de cr[ée]dito)\b/iu,
    // German PIN, login and bank-connection labels ("Geheimzahl", "Zugangsdaten", "Bankverbindung").
    /\b(?:geheimzahl|zugangsdaten|bankverbindung|kontoverbindung)\b/iu,
    // German compounds ("Kreditkartennummer", "Kontonummer").
    /(?:karten|konto)nummer/iu,
    // Scripts without word breaks: matched anywhere.
    /パスワード|暗証番号|口座番号|カード番号|密码|密碼|口令|账号|銀行卡|银行卡|卡号/u,
    // US social security numbers.
    /\b\d{3}-\d{2}-\d{4}\b/u,
    // Card, IBAN or account-like digit runs (13+ digits, spaces or dashes allowed).
    /(?:\d[ -]?){13,}/u,
    /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,}/iu,
];

/**
 * Words naming a health condition, a diagnosis or a treatment. A quote holding one is not kept: it can carry a diagnosis the
 * memory beside it never states ("I work as a teacher and was diagnosed with diabetes"). As with secrets, a false positive
 * only costs the quote, never the memory.
 */
const HEALTH_PATTERNS: ReadonlyArray<RegExp> = [
    /\bdiagnos\w*|\bdisease|\billness|\bsick(?:ness)?\b|\bdisorder/iu,
    /\bmedication|\bmeds\b|\bprescri(?:bed|ption)|\btherap(?:y|ies|ist)|\brehab\b/iu,
    /\bpsychiatr\w*|\bpsycholog\w*|\bdepress(?:ion|ed)|\banxiety|\bpanic attack/iu,
    /\bbipolar|\bschizophreni\w*|\badhd\b|\bautis\w*|\bmental health/iu,
    /\bcancer|\btumou?r|\bchemo\w*|\bdiabet\w*|\binsulin\b/iu,
    /\bhiv\b|\bpregnan\w*|\bmiscarriage|\bsurgery|\bchronic\b/iu,
    /\bsymptoms?\b|\ballerg\w*|\basthma|\bepilep\w*|\bantidepressant/iu,
    /\baddict\w*|\bhospitali[sz]ed|\bdisabilit(?:y|ies)|\bdisabled\b/iu,
    /\bhypertension|\blupus\b|\bmigraines?\b|\bstroke\b|\bheart (?:attack|disease|failure)/iu,
    /\bdementia|\balzheimer|\bparkinson|\bmultiple sclerosis|\bcrohn/iu,
    /\bco?eliac|\binfection|\bcovid|\bptsd\b|\bocd\b/iu,
    /\banorexi\w*|\bbulimi\w*|\bobes(?:e|ity)|\bcholesterol|\bblood pressure/iu,
    /\bthyroid|\bhepatitis|\bherpes|\bdialysis|\btransplant/iu,
    /\bdoctor|\bphysician|\bclinic\b|\bhospital\b|\binjur(?:y|ies|ed)/iu,
    // An inflammation (arthritis): the ending names nothing else. Other endings are listed by word, as "-emia" and "-osis"
    // also end ordinary ones ("academia", "osmosis").
    /\b\w{3,}itis\b|\b(?:carcin|melan|lymph|glauc)oma\b/iu,
    /\b(?:an|leuk|septic|isch|hypoglyc|hyperglyc)a?emia\b/iu,
    /\b(?:sclerosis|fibrosis|thrombosis|tuberculosis|osteoporosis|cirrhosis|endometriosis|scoliosis|psoriasis)\b/iu,
    // German, French, Spanish, Portuguese, Italian and Polish, the other languages the app ships in.
    /\bkrankheit|\berkrank\w*|\btherapie|\bmedikament\w*/iu,
    /\bschwanger\w*|\bkrebs\b|\bbehinderung|\bmaladie|\benceinte\b/iu,
    /\benfermedad|\bembarazada|\bdoen[çc]a|\bgr[áa]vida|\bmalattia/iu,
    /\bincinta\b|\bchoroba|\bw ci[ąa][żz]y/iu,
];

/**
 * Whether the text names a health condition, a diagnosis or a treatment. Both readings, as `looksSecret` reads them: an
 * invisible character inside a word (`dia\u200Bbetes`) hides it until dropped.
 */
const mentionsHealth = (text: string): boolean =>
    [text, text.replaceAll(INVISIBLE_RE, "")].some((reading) => HEALTH_PATTERNS.some((pattern) => pattern.test(reading.normalize("NFKC"))));

// `%` stays inside a token: a percent-encoded token (`%2F`) is one token, not pieces too short to read as a key.
const TOKEN_SPLIT_RE = /[^\w+/=%-]+/u;
const DIGIT_RE = /\d/u;
const LETTER_RE = /[a-z]/iu;

/** A long unbroken run mixing letters and digits, such as a generated key. */
const hasLongToken = (text: string): boolean => text.split(TOKEN_SPLIT_RE).some((token) => token.length >= 32 && DIGIT_RE.test(token) && LETTER_RE.test(token));

const normalise = (text: string): string => text.replaceAll(WHITESPACE_RE, " ").trim();

/** Where `wanted` first sits in `source` from `from` on, both normalised: case aside only where lower-casing keeps every offset in both (not so in rare scripts), elsewhere exact. */
const findWanted = (wanted: string, source: string, from = 0): number => {
    const foldable = source.toLowerCase().length === source.length && wanted.toLowerCase().length === wanted.length;

    return foldable ? source.toLowerCase().indexOf(wanted.toLowerCase(), from) : source.indexOf(wanted, from);
};

/**
 * How many characters of `userText`, normalised the way {@link evidenceQuote} reads it, run up to the end of the
 * span the quote matches; `undefined` when it matches none. Lets a caller tell which part of the text holds the
 * quoted copy without searching each part again.
 */
export const evidenceMatchEnd = (claimed: string | undefined, userText: string): number | undefined => {
    if (claimed === undefined) {
        return undefined;
    }

    const wanted = normalise(claimed);
    const at = findWanted(wanted, normalise(userText));

    return at === -1 ? undefined : at + wanted.length;
};

/** The length of `text` normalised the way {@link evidenceQuote} reads it. */
export const normalisedLength = (text: string): number => normalise(text).length;

/** Whether the text looks like it carries a credential or a card or account number. */
export const looksSecret = (text: string): boolean =>
    // Both readings: an invisible character inside a label (`pass\u200Bword`) hides it until dropped, and one
    // between two words (`my\u200Bpassword`) is the only boundary the label has, so dropping it alone would hide that one.
    // NFKC folds fullwidth Latin (`\uFF50\uFF41\uFF53\uFF53\uFF57\uFF4F\uFF52\uFF44`) into the ASCII the labels are written in.
    [text, text.replaceAll(INVISIBLE_RE, "")]
        .flatMap((reading) => [reading, reading.normalize("NFKC")])
        // `containsSecret` is the backend's one detector (`lib/secret-redaction.ts`); the patterns here add the labels it leaves alone.
        .some((reading) => hasLongToken(reading) || containsSecret(reading) || SECRET_PATTERNS.some((pattern) => pattern.test(reading)));

/**
 * The run of non-space characters the span `start..end` sits in. A URL's login is one such run however long its
 * username, so it is checked whole, where a fixed window around the quote can miss its scheme.
 */
const tokenAround = (source: string, start: number, end: number): string => {
    let left = start;
    let right = end;

    while (left > 0 && !SPACE_RE.test(source.charAt(left - 1))) {
        left -= 1;
    }

    while (right < source.length && !SPACE_RE.test(source.charAt(right))) {
        right += 1;
    }

    return source.slice(left, right);
};

/**
 * The quote to store for a memory, or `undefined` for none: the span of the
 * user's own text the extractor's quote matches (whitespace and case aside),
 * cut to {@link EVIDENCE_QUOTE_MAX_CHARS}, and not secret-looking. `before` is
 * set for steered text only: what the user wrote just before `userText` (the prompt, empty in a continuation
 * that has none), never quoted, only checked, so a label cannot sit across the boundary.
 */
export const evidenceQuote = (claimed: string | undefined, userText: string, before?: string): string | undefined => {
    if (claimed === undefined) {
        return undefined;
    }

    const wanted = normalise(claimed);
    const source = normalise(userText);
    const at = findWanted(wanted, source);

    if (wanted.length < EVIDENCE_QUOTE_MIN_CHARS || at === -1) {
        return undefined;
    }

    // Always the user's own span, never the extractor's wording of it.
    const quote = source.slice(at, at + wanted.length);

    // Checked on the whole quote and its surroundings, before the cut, so a secret cannot hide behind the cut point
    // or be quoted without its label ("my password is …").
    const besideSecret = (start: number): boolean => {
        const lead = before !== undefined && start < EVIDENCE_CONTEXT_CHARS ? normalise(before).slice(start - EVIDENCE_CONTEXT_CHARS) : "";

        return (
            looksSecret(`${lead} ${source.slice(Math.max(0, start - EVIDENCE_CONTEXT_CHARS), start + wanted.length + EVIDENCE_CONTEXT_CHARS)}`) ||
            looksSecret(tokenAround(source, start, start + wanted.length)) ||
            // A steer answers what came before it, however far back: a label in the prompt or an earlier steer
            // ("here is my password", then the value in a later message) marks the value wherever it lands.
            (before !== undefined && looksSecret(`${before} ${source.slice(0, start)}`))
        );
    };

    if (mentionsHealth(quote)) {
        return undefined;
    }

    // Every copy of the words is checked, not only the first: the same text said again beside a label is that label's value.
    for (let start = at; start !== -1; start = findWanted(wanted, source, start + 1)) {
        if (besideSecret(start)) {
            return undefined;
        }
    }

    if (quote.length <= EVIDENCE_QUOTE_MAX_CHARS) {
        return quote;
    }

    // Never between the two halves of a surrogate pair (an emoji), which would show as a broken character.
    const cut = EVIDENCE_QUOTE_MAX_CHARS - 1;
    const end = (quote.codePointAt(cut - 1) ?? 0) > 0xff_ff ? cut - 1 : cut;

    return `${quote.slice(0, end).trimEnd()}…`;
};

/**
 * The quote {@link evidenceQuote} takes from the person's typed text (`typed`, a blockquote or an attachment taken out),
 * with the label check that also reads the text as sent (`raw`): a quoted "What is your password?" sits right above a typed value that has no
 * label of its own once the quoted line is gone. A quote that cannot be placed in `raw` (it ran across the removed
 * text) is not kept: the person never wrote those words as one phrase.
 */
export const typedEvidenceQuote = (claimed: string | undefined, typed: string, raw: string, before?: string): string | undefined => {
    const quote = evidenceQuote(claimed, typed, before);

    if (quote === undefined || normalise(typed) === normalise(raw)) {
        return quote;
    }

    // Words that run together only once a quoted line or an attachment between them is gone were never written as one
    // phrase: the quote must stand in the text as sent, too.
    return evidenceQuote(claimed, raw, before) === undefined ? undefined : quote;
};

/** A memory's stored evidence. `at` is when the words were said, which ranks evidence when rows merge. */
export const vMemoryEvidence = v.object({ at: v.optional(v.number()), messageId: v.optional(v.string()), quote: v.string(), threadId: v.optional(v.string()) });

export type MemoryEvidence = Infer<typeof vMemoryEvidence>;

/**
 * The evidence said most recently, for a memory built from several (compression, reflection).
 * A row the user rewrote has none: `updateMemory` drops it.
 */
export const newestEvidence = (rows: ReadonlyArray<{ _creationTime: number; evidence?: MemoryEvidence | null }>): MemoryEvidence | undefined => {
    let best: { at: number; evidence: MemoryEvidence } | undefined;

    for (const row of rows) {
        // Not `updatedAt`: a decay or a type edit moves that without new words.
        const at = row.evidence?.at ?? row._creationTime;

        if (row.evidence && (best === undefined || at > best.at)) {
            best = { at, evidence: row.evidence };
        }
    }

    return best?.evidence;
};
