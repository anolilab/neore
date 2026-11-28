/**
 * The time a memory question asks about, read from its words without a model call: "last week", "tomorrow", "in May",
 * "im Dezember", "in 2023", "on 3 December", "2026-12-03". Pure: the phrase is read from the text alone, and resolved
 * against the user's local day (`YYYY-MM-DD`), never the clock. A text naming no time it knows has no window, and the
 * ranking is unchanged.
 *
 * English and German. Each language is one `Lexicon`; another is one more entry in `LEXICONS`. Words are compared
 * lowercased (the retrieval cache lowercases the text), so a month that is also a word (`may`, `march`) counts only
 * beside a preposition, a day number or a year. Weeks start on Monday.
 */

/** The asked time as local days, both inclusive, and the day it was read on. */
export interface TimeWindow {
    end: string;
    /** The question asks about the time alone ("what is coming up tomorrow"): it has no word the lexicons do not know. */
    onlyTime?: boolean;
    start: string;
    today: string;
}

type Shift = -1 | 0 | 1;
type Unit = "month" | "week" | "year";
type Tense = "future" | "past" | undefined;

/** A time phrase before it is resolved against a day. */
export type TimePhrase =
    /**
     * `yearShift`: a relative year beside the month ("in May last year"), counted from today's year. `nearest`: a shift
     * word before it ("next May", "letzten Mai"), the first such month after today or the last before it.
     */
    (
        | { day?: number; kind: "date"; month: number; nearest?: Shift; tense: Tense; year?: number; yearShift?: Shift }
        | { days: number; kind: "offset" }
        | { kind: "relative"; shift: Shift; unit: Unit }
        | { kind: "year"; year: number }
    ) & { onlyTime?: boolean };

interface Lexicon {
    /** Words after a number of days that count back (`3 days ago`). */
    agoAfter: string[];
    /** Words before a number of days that count back (`vor 3 Tagen`). */
    agoBefore: string[];
    /** Words before a number of days that count ahead (`in 3 days`). */
    ahead: string[];
    /** Question and agenda words: a question of only these and time words asks about the time alone. */
    asking: string[];
    /**
     * A day word, and the words before it that make it something else (`guten Morgen` is no tomorrow), right before it
     * or with an adjective between (`am frühen Morgen`).
     */
    days: Record<string, { blockedAfter?: string[]; offset: number }>;
    dayUnits: string[];
    /** Words of a question about what will be (a month without a year is then the next one). */
    future: string[];
    /** Words that mark the next word as a month or a year: a preposition. */
    leads: string[];
    months: string[][];
    numbers: Record<string, number>;
    /** Words of a question about what was (a month without a year is then the latest one). */
    past: string[];
    /** A simple-past form no list can hold (a regular `-ed` verb after `I`), the word at `index` of the question. */
    pastForm?: (index: number, words: ReadonlyArray<string>) => boolean;
    shifts: Record<string, Shift>;
    units: Record<string, Unit>;
    /** Words that mark the next number as a year (`in 2023`); fewer than `leads`, so `an essay of 2050 words` is no year. */
    yearLeads: string[];
}

/** German adjectives in each of their endings: `letzte`, `letzten`, `letzter`, `letztes`, `letztem`. */
const inflected = (stems: [string, Shift][]): Record<string, Shift> =>
    Object.fromEntries(stems.flatMap(([stem, shift]) => ["e", "en", "er", "es", "em"].map((ending) => [`${stem}${ending}`, shift])));

/** Month names, a space between months and a comma between the names of one: `januar,jänner februar …`. */
const monthsOf = (names: string): string[][] => names.split(" ").map((month) => month.split(","));

const ENGLISH: Lexicon = {
    agoAfter: ["ago"],
    agoBefore: [],
    ahead: ["in"],
    asking: "what whats s is are am was were i me my do did does doing have has had on up at the a for to be there anything any and or happening happen scheduled schedule agenda".split(
        " ",
    ),
    days: { today: { offset: 0 }, tomorrow: { offset: 1 }, tonight: { offset: 0 }, yesterday: { offset: -1 } },
    dayUnits: ["day", "days"],
    future: ["will", "plan", "plans", "planned", "planning", "upcoming", "coming", "going", "next"],
    leads: ["in", "on", "during", "for", "of", "since", "until", "by", "from", "before", "after"],
    months: monthsOf("january february march april may june july august september october november december"),
    numbers: { a: 1, eight: 8, five: 5, four: 4, nine: 9, one: 1, seven: 7, six: 6, ten: 10, three: 3, two: 2 },
    past: ["did", "was", "were", "had", "went", "ago", "last", "saw"],
    // The simple past only: `I booked`, `where I lived`, `what happened`. A participle after have/has/had is the perfect
    // (`what have I booked for December` asks of a booking ahead) and sets no tense; `I need` is no `-ed` verb.
    pastForm: (index, words) => {
        const [word, before, beforeThat] = [words[index]!, words[index - 1], words[index - 2]];

        if ([before, beforeThat].some((auxiliary) => auxiliary !== undefined && ["had", "has", "have"].includes(auxiliary))) {
            return false;
        }

        const regular = (before === "i" || before === "we") && word.length >= 4 && word.endsWith("ed") && !word.endsWith("eed");

        return regular || ["bought", "happened", "lived", "met"].includes(word);
    },
    shifts: { coming: 1, last: -1, next: 1, this: 0 },
    units: { month: "month", week: "week", year: "year" },
    yearLeads: ["in", "during", "since", "until"],
};

const GERMAN: Lexicon = {
    agoAfter: [],
    agoBefore: ["vor"],
    ahead: ["in"],
    asking: "was wann ist sind steht stehen an los habe hast hat haben ich mein meine meinen mir gibt es termin termine da denn noch alles etwas mache machen der die das den dem".split(
        " ",
    ),
    days: {
        gestern: { offset: -1 },
        heute: { offset: 0 },
        // `heute Morgen` reads `heute` first; `guten Morgen`, `am (frühen) Morgen`, `jeden Morgen` are mornings, not tomorrow.
        morgen: { blockedAfter: ["guten", "am", "jeden", "diesen", "den", "einen", "einem", "dem", "der", "vom", "heute", "gestern"], offset: 1 },
    },
    dayUnits: ["tag", "tage", "tagen"],
    future: ["werde", "wird", "werden", "plane", "planen", "geplant", "pläne", "plan", "vor", "bevorstehend", "ansteht", "kommenden", "nächsten"],
    leads: ["im", "in", "am", "seit", "bis", "für", "ab", "vom", "von", "zum", "anfang", "ende", "mitte", "jahr"],
    months: monthsOf("januar,jänner februar märz,maerz april mai juni juli august september oktober november dezember"),
    numbers: { acht: 8, drei: 3, ein: 1, einem: 1, einen: 1, fünf: 5, neun: 9, sechs: 6, sieben: 7, vier: 4, zehn: 10, zwei: 2 },
    // The simple past (`war`, `hatte`), and the participles of what happened (`gemacht`, `gewesen`, `passiert`): spoken
    // German asks of the past in the perfect. Any other participle beside `habe` sets no tense: `was habe ich im
    // Dezember gebucht` asks of a booking ahead.
    past: ["war", "waren", "warst", "hatte", "hatten", "gemacht", "gewesen", "letzten", "gestern", "passiert"],
    shifts: inflected([
        ["dies", 0],
        ["letzt", -1],
        ["vorig", -1],
        ["vergangen", -1],
        ["nächst", 1],
        ["naechst", 1],
        ["kommend", 1],
    ]),
    units: { jahr: "year", jahres: "year", monat: "month", monats: "month", woche: "week" },
    yearLeads: ["im", "in", "jahr", "seit", "bis"],
};

/** The languages read, in order. A new one is a `Lexicon` added here, with its rows in `time-window.test.ts`. */
const LEXICONS: ReadonlyArray<Lexicon> = [ENGLISH, GERMAN];

/** The most of a question read: a time phrase sits near the words that ask. */
const MAX_TEXT_LENGTH = 1000;

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const YEAR_RE = /^(?:19|20|21)\d{2}$/u;
const DAY_NUMBER_RE = /^(\d{1,2})(?:st|nd|rd|th)?$/u;
const SMALL_NUMBER_RE = /^\d{1,3}$/u;
const ISO_DAY_RE = /^\d{1,2}$/u;
/** A German adjective's ending before a noun: `frühen`, `späten`, `ganzen`. */
const isAdjective = (word: string): boolean => word.length > 3 && ["en", "em", "er"].some((ending) => word.endsWith(ending));

interface Token {
    end: number;
    start: number;
    word: string;
}

const tokensOf = (text: string): Token[] =>
    [...text.matchAll(TOKEN_RE)].map((match) => {
        return { end: match.index + match[0].length, start: match.index, word: match[0] };
    });

const dayNumberOf = (word: string | undefined): number | undefined => {
    const match = word === undefined ? null : DAY_NUMBER_RE.exec(word);
    const day = match ? Number(match[1]) : 0;

    return day >= 1 && day <= 31 ? day : undefined;
};

const yearOf = (word: string | undefined): number | undefined => (word !== undefined && YEAR_RE.test(word) ? Number(word) : undefined);

const countOf = (word: string | undefined, lexicon: Lexicon): number | undefined => {
    if (word === undefined) {
        return undefined;
    }

    return SMALL_NUMBER_RE.test(word) ? Number(word) : lexicon.numbers[word];
};

const monthIndexOf = (word: string | undefined, lexicon: Lexicon): number | undefined => {
    const index = word === undefined ? -1 : lexicon.months.findIndex((names) => names.includes(word));

    return index === -1 ? undefined : index + 1;
};

/** `2026-12-03` or `2026-12`, spelled with hyphens. */
const isoAt = (text: string, tokens: Token[], at: number): TimePhrase | undefined => {
    const [year, month, day] = [tokens[at], tokens[at + 1], tokens[at + 2]];
    const joined = (a: Token | undefined, b: Token | undefined): boolean => a !== undefined && b !== undefined && text.slice(a.end, b.start) === "-";

    if (yearOf(year?.word) === undefined || !joined(year, month) || month!.word.length !== 2) {
        return undefined;
    }

    // `2026-12-03` and `2026-12-3` alike.
    const withDay = joined(month, day) && ISO_DAY_RE.test(day!.word);

    return { ...(withDay && { day: Number(day!.word) }), kind: "date", month: Number(month!.word), tense: undefined, year: Number(year!.word) };
};

/** A phrase starting at token `at`, in one language. */
const phraseAt = (words: string[], at: number, lexicon: Lexicon, tense: Tense): TimePhrase | undefined => {
    const [word, next, after] = [words[at]!, words[at + 1], words[at + 2]];
    const day = lexicon.days[word];

    const [before, adjective] = [words[at - 2] ?? "", words[at - 1] ?? ""];
    const blocked = day?.blockedAfter?.includes(adjective) === true || (isAdjective(adjective) && day?.blockedAfter?.includes(before) === true);

    if (day !== undefined && !blocked) {
        return { days: day.offset, kind: "offset" };
    }

    const shift = lexicon.shifts[word];
    const unit = next === undefined ? undefined : lexicon.units[next];

    if (shift !== undefined && unit !== undefined) {
        return { kind: "relative", shift, unit };
    }

    // `next May`, `letzten Mai`, `next May 3`; a year after it wins over the shift (`last May 2023`). `this May` is left
    // to the rest (`this may take long` is no month).
    const shiftedMonth = shift === undefined || shift === 0 ? undefined : monthIndexOf(next, lexicon);

    if (shift !== undefined && shiftedMonth !== undefined) {
        const shiftedDay = dayNumberOf(after);
        const shiftedYear = yearOf(shiftedDay === undefined ? after : words[at + 3]);

        return {
            kind: "date",
            month: shiftedMonth,
            tense,
            ...(shiftedDay !== undefined && { day: shiftedDay }),
            ...(shiftedYear === undefined ? { nearest: shift } : { year: shiftedYear }),
        };
    }

    const count = countOf(next, lexicon);
    const isDays = after !== undefined && lexicon.dayUnits.includes(after);

    if (count !== undefined && isDays && lexicon.ahead.includes(word)) {
        return { days: count, kind: "offset" };
    }

    if (count !== undefined && isDays && lexicon.agoBefore.includes(word)) {
        return { days: -count, kind: "offset" };
    }

    const leadingCount = countOf(word, lexicon);

    if (leadingCount !== undefined && next !== undefined && lexicon.dayUnits.includes(next) && after !== undefined && lexicon.agoAfter.includes(after)) {
        return { days: -leadingCount, kind: "offset" };
    }

    // `3 December`, `3rd of December`, `am 3. Dezember`, with a year after or without.
    const dayFirst = dayNumberOf(word);
    const ofMonth = monthIndexOf(next === "of" ? after : next, lexicon);

    if (dayFirst !== undefined && ofMonth !== undefined) {
        const year = yearOf(words[at + (next === "of" ? 3 : 2)]);

        return { day: dayFirst, kind: "date", month: ofMonth, tense, ...(year !== undefined && { year }) };
    }

    // A month beside a preposition, a day number or a year: `in May`, `December 3`, `May 2023`.
    const month = monthIndexOf(word, lexicon);
    const dayAfter = dayNumberOf(next);
    const yearAfter = yearOf(dayAfter === undefined ? next : after);

    if (month !== undefined && (lexicon.leads.includes(words[at - 1] ?? "") || dayAfter !== undefined || yearAfter !== undefined)) {
        return { kind: "date", month, tense, ...(dayAfter !== undefined && { day: dayAfter }), ...(yearAfter !== undefined && { year: yearAfter }) };
    }

    const year = yearOf(next);

    return lexicon.yearLeads.includes(word) && year !== undefined ? { kind: "year", year } : undefined;
};

/**
 * Whether the question asks about what was or what will be, by the words of the language its phrase is in (English
 * `was` is German `what`); `undefined` when it says neither or both.
 */
const tenseOf = (words: string[], lexicon: Lexicon): Tense => {
    const past = words.some((word, index) => lexicon.past.includes(word) || lexicon.pastForm?.(index, words) === true);
    const future = words.some((word) => lexicon.future.includes(word));

    if (past === future) {
        return undefined;
    }

    return past ? "past" : "future";
};

/** Every word a lexicon knows. */
const LEXICON_WORDS = new Map(
    LEXICONS.map((lexicon) => [
        lexicon,
        new Set(
            [
                lexicon.agoAfter,
                lexicon.agoBefore,
                lexicon.ahead,
                lexicon.asking,
                lexicon.dayUnits,
                lexicon.future,
                lexicon.leads,
                lexicon.past,
                lexicon.yearLeads,
                ...lexicon.months,
                Object.keys(lexicon.days),
                Object.keys(lexicon.numbers),
                Object.keys(lexicon.shifts),
                Object.keys(lexicon.units),
            ].flat(),
        ),
    ]),
);

const isNumber = (word: string): boolean => SMALL_NUMBER_RE.test(word) || DAY_NUMBER_RE.test(word) || YEAR_RE.test(word);

/** The tokens after a phrase's first one that it may use: `3rd of December 2023`, `nächstes Jahr am 3. April`. */
const PHRASE_SPAN = 4;

/** The words that may join a month and a relative year: `in May last year`, `letztes Jahr im Mai`. */
const MAX_YEAR_GAP = 4;

/** The text's ISO date if it has one (the most exact a question can be), else its first time phrase in any language read. */
export const readTimePhrase = (text: string): TimePhrase | undefined => {
    // Offsets are of the lowercased text: lowercasing can change a string's length.
    const lowered = text.slice(0, MAX_TEXT_LENGTH).normalize("NFC").toLowerCase();
    const tokens = tokensOf(lowered);
    const words = tokens.map(({ word }) => word);
    // The language that knows most of the question's words reads first, and its own words give the tense: `am 3. April`
    // is German in "was habe ich am 3. April gemacht", whose `was` is no English past. A tie keeps `LEXICONS` order.
    const known = (lexicon: Lexicon): number => words.filter((word) => LEXICON_WORDS.get(lexicon)!.has(word)).length;
    const ranked = LEXICONS.toSorted((a, b) => known(b) - known(a)).map((lexicon) => {
        return { lexicon, tense: tenseOf(words, lexicon) };
    });
    const phraseFrom = (index: number): TimePhrase | undefined => ranked.map(({ lexicon, tense }) => phraseAt(words, index, lexicon, tense)).find(Boolean);
    // A month without a year and a relative year near it are one time: `in May last year` is May of 2025.
    const firstNear = (from: number, wanted: (near: TimePhrase) => boolean): TimePhrase | undefined => {
        for (let index = from + 1; index <= from + MAX_YEAR_GAP && index < tokens.length; index += 1) {
            const near = phraseFrom(index);

            if (near !== undefined && wanted(near)) {
                return near;
            }
        }

        return undefined;
    };
    const isRelativeYear = (near: TimePhrase): boolean => near.kind === "relative" && near.unit === "year";
    const isYearlessMonth = (near: TimePhrase): boolean => near.kind === "date" && near.year === undefined;
    const withNearYear = (phrase: TimePhrase, index: number): TimePhrase => {
        if (phrase.kind === "date" && phrase.year === undefined) {
            const near = firstNear(index, isRelativeYear);

            return near?.kind === "relative" ? { ...phrase, yearShift: near.shift } : phrase;
        }

        if (phrase.kind !== "relative" || phrase.unit !== "year") {
            return phrase;
        }

        const month = firstNear(index, isYearlessMonth);

        return month?.kind === "date" ? { ...month, yearShift: phrase.shift } : phrase;
    };

    const at = (read: (index: number) => TimePhrase | undefined): { phrase: TimePhrase; start: number } | undefined => {
        for (let index = 0; index < tokens.length; index += 1) {
            const phrase = read(index);

            if (phrase !== undefined) {
                return { phrase, start: index };
            }
        }

        return undefined;
    };

    const found =
        at((index) => isoAt(lowered, tokens, index)) ??
        at((index) => {
            const near = phraseFrom(index);

            return near === undefined ? undefined : withNearYear(near, index);
        });

    if (found === undefined) {
        return undefined;
    }

    // A question cut at `MAX_TEXT_LENGTH` may name a topic past the cut: it is never about the time alone. A number is a
    // time word only inside the phrase (`in 100 days`); `42` in "what is on 42 tomorrow" is something else.
    const whole = text.length <= MAX_TEXT_LENGTH;
    const inPhrase = (index: number): boolean => index >= found.start && index <= found.start + PHRASE_SPAN;
    const isTimeWord = (word: string, index: number): boolean =>
        isNumber(word) ? inPhrase(index) : LEXICONS.some((lexicon) => LEXICON_WORDS.get(lexicon)!.has(word));

    return { ...found.phrase, onlyTime: whole && words.every((word, index) => isTimeWord(word, index)) };
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** The day `Date.UTC` normalises the parts to (day 0 is the last of the month before, month 13 the January after). */
const dayOf = (year: number, month: number, day: number): string => {
    const date = new Date(Date.UTC(year, month - 1, day));

    return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

type Span = Pick<TimeWindow, "end" | "start">;

const isRealDay = (year: number, month: number, day: number): boolean =>
    month >= 1 && month <= 12 && dayOf(year, month, day) === `${String(year)}-${pad(month)}-${pad(day)}`;

/** A month, or one day of it, of `year`; `undefined` for a day the month does not have. */
const calendarSpan = (year: number, month: number, day: number | undefined): Span | undefined => {
    if (day !== undefined) {
        return isRealDay(year, month, day) ? { end: dayOf(year, month, day), start: dayOf(year, month, day) } : undefined;
    }

    return month >= 1 && month <= 12 ? { end: dayOf(year, month + 1, 0), start: dayOf(year, month, 1) } : undefined;
};

/**
 * The window a phrase names, read on `today` (the user's local day). A month or day without a year is the latest one
 * on or before today for a question about what was, the next one ending on or after today for one about what will be,
 * and this year's otherwise. `undefined` for a day that does not exist (`31 February`, `29 February 2027`).
 */
export const windowOf = (phrase: TimePhrase, today: string): TimeWindow | undefined => {
    const span = spanOf(phrase, today);

    return span === undefined ? undefined : { ...span, ...(phrase.onlyTime === true && { onlyTime: true }), today };
};

const spanOf = (phrase: TimePhrase, today: string): Span | undefined => {
    const [year, month, day] = today.split("-").map(Number) as [number, number, number];

    if (phrase.kind === "date") {
        if (phrase.year !== undefined || phrase.yearShift !== undefined) {
            return calendarSpan(phrase.year ?? year + phrase.yearShift!, phrase.month, phrase.day);
        }

        const current = calendarSpan(year, phrase.month, phrase.day);

        if (phrase.nearest === 1) {
            return current !== undefined && current.start > today ? current : calendarSpan(year + 1, phrase.month, phrase.day);
        }

        if (phrase.nearest === -1) {
            return current !== undefined && current.end < today ? current : calendarSpan(year - 1, phrase.month, phrase.day);
        }

        if (phrase.tense === "past" && current !== undefined && current.start > today) {
            return calendarSpan(year - 1, phrase.month, phrase.day);
        }

        return phrase.tense === "future" && current !== undefined && current.end < today ? calendarSpan(year + 1, phrase.month, phrase.day) : current;
    }

    if (phrase.kind === "offset") {
        const at = dayOf(year, month, day + phrase.days);

        return { end: at, start: at };
    }

    if (phrase.kind === "year" || phrase.unit === "year") {
        const asked = phrase.kind === "year" ? phrase.year : year + phrase.shift;

        return { end: `${String(asked)}-12-31`, start: `${String(asked)}-01-01` };
    }

    if (phrase.unit === "month") {
        return { end: dayOf(year, month + phrase.shift + 1, 0), start: dayOf(year, month + phrase.shift, 1) };
    }

    // Monday-based: getUTCDay is 0 on Sunday.
    const monday = day - ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + phrase.shift * 7;

    return { end: dayOf(year, month, monday + 6), start: dayOf(year, month, monday) };
};

/** The window the text asks about, read on `today`, or `undefined` when it names none. */
export const timeWindowOf = (text: string, today: string): TimeWindow | undefined => {
    const phrase = readTimePhrase(text);

    return phrase === undefined ? undefined : windowOf(phrase, today);
};

/** Days in a window, both ends counted. */
export const windowDays = ({ end, start }: Span): number => (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
