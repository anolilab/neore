import { describe, expect, it } from "vitest";

import { localDayOf } from "./reflection-logic";
import { OPEN_END, OPEN_START, timeWindowOf } from "./time-window";

/** A Friday. */
const TODAY = "2026-11-27";

const windowOf = (text: string, today = TODAY): [string, string] | [string, string][] | undefined => {
    const window = timeWindowOf(text, today);

    // One span as `[start, end]`; several as a list of them.
    if (window === undefined) {
        return undefined;
    }

    const spans = window.spans.map(({ end, start }): [string, string] => [start, end]);

    return spans.length === 1 ? spans[0] : spans;
};

describe("timeWindowOf", () => {
    it.each([
        // English: a day, this / last / next, a count of days
        ["what is coming up tomorrow", ["2026-11-28", "2026-11-28"]],
        ["who did I meet yesterday", ["2026-11-26", "2026-11-26"]],
        ["anything on today or tonight", ["2026-11-27", "2026-11-27"]],
        ["what did I do last week", ["2026-11-16", "2026-11-22"]],
        ["what is on this week", ["2026-11-23", "2026-11-29"]],
        ["what is happening next week", ["2026-11-30", "2026-12-06"]],
        ["the coming week", ["2026-11-30", "2026-12-06"]],
        ["what did I spend last month", ["2026-10-01", "2026-10-31"]],
        ["plans for next month", ["2026-12-01", "2026-12-31"]],
        ["my goals this year", ["2026-01-01", "2026-12-31"]],
        ["what I read last year", ["2025-01-01", "2025-12-31"]],
        ["what do I have in 3 days", ["2026-11-30", "2026-11-30"]],
        ["the call in two days", ["2026-11-29", "2026-11-29"]],
        ["what did I cook 5 days ago", ["2026-11-22", "2026-11-22"]],
        // English: a month or a day, with a year or without
        ["what did I do about coffee in May", ["2026-05-01", "2026-05-31"]],
        ["what did I do in November", ["2026-11-01", "2026-11-30"]],
        ["what did I do in December", ["2025-12-01", "2025-12-31"]],
        ["my plans for December", ["2026-12-01", "2026-12-31"]],
        ["my plans for January", ["2027-01-01", "2027-01-31"]],
        ["what is planned for 3 December", ["2026-12-03", "2026-12-03"]],
        ["what is on December 3rd", ["2026-12-03", "2026-12-03"]],
        ["the 3rd of december 2023", ["2023-12-03", "2023-12-03"]],
        ["where did I travel in May 2023", ["2023-05-01", "2023-05-31"]],
        ["where was I living in 2023", ["2023-01-01", "2023-12-31"]],
        ["what was I doing on 2026-11-22", ["2026-11-22", "2026-11-22"]],
        ["what is due on 2026-12-3", ["2026-12-03", "2026-12-03"]],
        // A shift word before a month: the next one after today, the last one before it
        ["what is planned for next May", ["2027-05-01", "2027-05-31"]],
        ["what did I do last May", ["2026-05-01", "2026-05-31"]],
        ["what did I do last December", ["2025-12-01", "2025-12-31"]],
        ["was habe ich nächsten Mai vor", ["2027-05-01", "2027-05-31"]],
        ["was war letzten Dezember", ["2025-12-01", "2025-12-31"]],
        // Past forms beyond the list: a regular verb after `I`, a German participle beside `habe`
        ["what happened in December", ["2025-12-01", "2025-12-31"]],
        ["where I lived in May", ["2026-05-01", "2026-05-31"]],
        ["where I lived in December", ["2025-12-01", "2025-12-31"]],
        ["what I booked in December", ["2025-12-01", "2025-12-31"]],
        ["was ist im Dezember passiert", ["2025-12-01", "2025-12-31"]],
        ["I booked a table in December", ["2025-12-01", "2025-12-31"]],
        ["wo war ich im Mai", ["2026-05-01", "2026-05-31"]],
        ["wo war ich im Dezember", ["2025-12-01", "2025-12-31"]],
        // The perfect sets no tense: a booking asked of is usually ahead
        ["what have I booked for December", ["2026-12-01", "2026-12-31"]],
        ["was habe ich im Dezember gebucht", ["2026-12-01", "2026-12-31"]],
        // Two days off, before the one-day words
        ["what is on the day after tomorrow", ["2026-11-29", "2026-11-29"]],
        ["who did I meet the day before yesterday", ["2026-11-25", "2026-11-25"]],
        ["was steht übermorgen an", ["2026-11-29", "2026-11-29"]],
        ["was war vorgestern", ["2026-11-25", "2026-11-25"]],
        // Several phrases are one window while it stays within a month; past that, the first alone
        [
            "what is on today or tomorrow",
            [
                ["2026-11-27", "2026-11-27"],
                ["2026-11-28", "2026-11-28"],
            ],
        ],
        [
            "was steht heute oder morgen an",
            [
                ["2026-11-27", "2026-11-27"],
                ["2026-11-28", "2026-11-28"],
            ],
        ],
        [
            "what is on 3 December or 5 December",
            [
                ["2026-12-03", "2026-12-03"],
                ["2026-12-05", "2026-12-05"],
            ],
        ],
        // A relative year never joins a month across `or`
        [
            "what did I do in May or last year",
            [
                ["2026-05-01", "2026-05-31"],
                ["2025-01-01", "2025-12-31"],
            ],
        ],
        [
            "what is planned for May and next year",
            [
                ["2027-05-01", "2027-05-31"],
                ["2027-01-01", "2027-12-31"],
            ],
        ],
        [
            "was steht im Mai und nächstes Jahr an",
            [
                ["2027-05-01", "2027-05-31"],
                ["2027-01-01", "2027-12-31"],
            ],
        ],
        // A year after a group of months is every month's; a month and a year phrase stay apart
        [
            "what events did I have in May and June last year",
            [
                ["2025-05-01", "2025-05-31"],
                ["2025-06-01", "2025-06-30"],
            ],
        ],
        [
            "im Mai und Juni letztes Jahr",
            [
                ["2025-05-01", "2025-05-31"],
                ["2025-06-01", "2025-06-30"],
            ],
        ],
        [
            "what did I do in March, April and May 2024",
            [
                ["2024-03-01", "2024-03-31"],
                ["2024-04-01", "2024-04-30"],
                ["2024-05-01", "2024-05-31"],
            ],
        ],
        [
            "what did I do in May and June",
            [
                ["2026-05-01", "2026-05-31"],
                ["2026-06-01", "2026-06-30"],
            ],
        ],
        [
            "what did I do in May and June in 2024",
            [
                ["2024-05-01", "2024-05-31"],
                ["2024-06-01", "2024-06-30"],
            ],
        ],
        [
            "what did I do in May and June of 2024",
            [
                ["2024-05-01", "2024-05-31"],
                ["2024-06-01", "2024-06-30"],
            ],
        ],
        [
            "was war im Mai und Juni im Jahr 2024",
            [
                ["2024-05-01", "2024-05-31"],
                ["2024-06-01", "2024-06-30"],
            ],
        ],
        ["what did I do in May of 2023", ["2023-05-01", "2023-05-31"]],
        ["was war im Mai im Jahr 2023", ["2023-05-01", "2023-05-31"]],
        // `für den Morgen` is the morning of the day named
        ["Was ist für den Morgen am 3. Dezember geplant?", ["2026-12-03", "2026-12-03"]],
        // `going` is future only in `going to`; an `-ed` word after am/is/are is the passive
        ["what was going on in May", ["2026-05-01", "2026-05-31"]],
        ["what was going on in December", ["2025-12-01", "2025-12-31"]],
        ["what am I going to do in January", ["2027-01-01", "2027-01-31"]],
        ["am I booked for December", ["2026-12-01", "2026-12-31"]],
        ["am I scheduled for anything in January", ["2027-01-01", "2027-01-31"]],
        // `Morgen` after one of the adjectives is the morning; after a noun it is tomorrow
        ["was mache ich mit der Schwester morgen", ["2026-11-28", "2026-11-28"]],
        ["was lerne ich mit dem Lehrer morgen", ["2026-11-28", "2026-11-28"]],
        // Agenda words ask of what is ahead
        ["what is scheduled for January", ["2027-01-01", "2027-01-31"]],
        ["was steht im Januar an", ["2027-01-01", "2027-01-31"]],
        // `vor` is a future cue only as the particle that ends the clause, never "before"
        ["Was war im Mai vor der Reise?", ["2026-05-01", "2026-05-31"]],
        ["Was war im Dezember vor der Reise?", ["2025-12-01", "2025-12-31"]],
        ["was habe ich im Dezember vor der Reise gemacht", ["2025-12-01", "2025-12-31"]],
        ["was habe ich vor drei Tagen gemacht", ["2026-11-24", "2026-11-24"]],
        // A shifted month keeps a day or year after it; the year wins over the shift
        ["what is on next May 3", ["2027-05-03", "2027-05-03"]],
        ["what did I do last May 2023", ["2023-05-01", "2023-05-31"]],
        // No past cue: `need` is no `-ed` verb, `geplant` stays future
        ["I need the car in December", ["2026-12-01", "2026-12-31"]],
        ["was habe ich für Januar geplant", ["2027-01-01", "2027-01-31"]],
        ["the bills of 2026-10", ["2026-10-01", "2026-10-31"]],
        // German
        ["was steht morgen an", ["2026-11-28", "2026-11-28"]],
        ["was habe ich heute morgen gegessen", ["2026-11-27", "2026-11-27"]],
        ["mit wem war ich gestern essen", ["2026-11-26", "2026-11-26"]],
        ["was habe ich letzte Woche gemacht", ["2026-11-16", "2026-11-22"]],
        ["was ist nächste Woche los", ["2026-11-30", "2026-12-06"]],
        ["habe ich nächsten Monat noch einen Parkplatz", ["2026-12-01", "2026-12-31"]],
        ["in der vergangenen Woche", ["2026-11-16", "2026-11-22"]],
        ["meine Ziele dieses Jahr", ["2026-01-01", "2026-12-31"]],
        ["welche Stunde habe ich in 3 Tagen", ["2026-11-30", "2026-11-30"]],
        ["was war vor 5 Tagen", ["2026-11-22", "2026-11-22"]],
        ["was habe ich im Mai gemacht", ["2026-05-01", "2026-05-31"]],
        ["was habe ich im Januar vor", ["2027-01-01", "2027-01-31"]],
        ["was ist am 3. Dezember geplant", ["2026-12-03", "2026-12-03"]],
        ["wohin bin ich im Mai 2023 gereist", ["2023-05-01", "2023-05-31"]],
        ["wo habe ich im Jahr 2023 gewohnt", ["2023-01-01", "2023-12-31"]],
        ["die Reise im März 2024", ["2024-03-01", "2024-03-31"]],
        // A month with a relative year beside it, before or after
        ["what did I do in May last year", ["2025-05-01", "2025-05-31"]],
        ["plans for December next year", ["2027-12-01", "2027-12-31"]],
        ["the trip in May this year", ["2026-05-01", "2026-05-31"]],
        ["was war im Mai letzten Jahres", ["2025-05-01", "2025-05-31"]],
        ["letztes Jahr im Mai", ["2025-05-01", "2025-05-31"]],
        ["nächstes Jahr am 3. April", ["2027-04-03", "2027-04-03"]],
        // `Morgen` the time of day is no tomorrow; `morgen` the adverb is
        ["habe ich morgen frei", ["2026-11-28", "2026-11-28"]],
        ["wir sehen uns morgen früh", ["2026-11-28", "2026-11-28"]],
        // An adjective stem blocks only with its inflection: `spätestens` and `Frühstück` are other words
        ["was muss ich spätestens morgen erledigen", ["2026-11-28", "2026-11-28"]],
        ["was gibt es zum Frühstück morgen", ["2026-11-28", "2026-11-28"]],
    ])("reads %j", (text, expected) => {
        expect(windowOf(text)).toEqual(expected);
    });

    it.each([
        "what is my favourite coffee",
        "I may go there with friends",
        "this may take a while",
        "march to the beat",
        "guten Morgen, wie geht's",
        "was mache ich jeden Morgen",
        "was habe ich am frühen Morgen gemacht",
        "am Morgen laufe ich",
        "den ganzen Morgen geregnet",
        "was mache ich an einem frühen Morgen",
        "a 2023 vintage from the shop",
        "walked 15000 steps",
        "an essay of 2050 words",
        "set the limit for 2048 tokens",
        "the 1990s were fun",
        "what was my last ride like",
        // A word that is a key of every object is no lexicon entry.
        "the constructor of the class",
        "der constructor der Klasse",
    ])("names no time in %j", (text) => {
        expect(windowOf(text)).toBeUndefined();
    });

    it("tells a question about the time alone from one about a topic at a time", () => {
        const only = (text: string) => timeWindowOf(text, TODAY)?.onlyTime === true;

        expect(
            ["what is coming up tomorrow", "what are my plans for December", "was steht morgen an", "was habe ich letzte Woche gemacht"].map((text) =>
                only(text),
            ),
        ).toEqual([true, true, true, true]);
        // A count of days is a time word; a question cut past the scanned length may name its topic after the cut.
        expect(only("what is coming up in 100 days")).toBe(true);
        // A number is a time word only inside the phrase.
        expect(only("what is on 42 tomorrow")).toBe(false);
        // Agenda nouns ask of the time alone.
        expect(only("what are my appointments tomorrow")).toBe(true);
        expect(only("what am I going to do tomorrow")).toBe(true);
        expect(only("was mache ich morgen")).toBe(true);
        expect(only("was für Termine habe ich morgen")).toBe(true);
        expect(only("was steht heute oder morgen an")).toBe(true);
        expect(only(`what is coming up tomorrow ${"and ".repeat(250)}about the weather`)).toBe(false);
        expect(["what is the weather like tomorrow", "draft an email saying I am away next week", "was koche ich heute"].map((text) => only(text))).toEqual([
            false,
            false,
            false,
        ]);
    });

    it("reads the day in the user's time zone: 23:30 UTC is already tomorrow in Berlin and still today in Los Angeles", () => {
        const instant = Date.UTC(2026, 10, 27, 23, 30);

        expect(windowOf("what is on tomorrow", localDayOf(instant, "Europe/Berlin"))).toEqual(["2026-11-29", "2026-11-29"]);
        expect(windowOf("what is on tomorrow", localDayOf(instant, "UTC"))).toEqual(["2026-11-28", "2026-11-28"]);
        expect(windowOf("what is on tomorrow", localDayOf(instant, "America/Los_Angeles"))).toEqual(["2026-11-28", "2026-11-28"]);
        expect(windowOf("what is on tomorrow", localDayOf(instant, undefined))).toEqual(["2026-11-28", "2026-11-28"]);
    });

    it("knows a leap day, and no day a month lacks", () => {
        expect(windowOf("what is on 29 February 2028")).toEqual(["2028-02-29", "2028-02-29"]);
        expect(windowOf("what is on 29 February 2027")).toBeUndefined();
        expect(windowOf("what is on 31 February")).toBeUndefined();
        expect(windowOf("what did I do last month", "2028-03-15")).toEqual(["2028-02-01", "2028-02-29"]);
        expect(windowOf("what is due in 3 days", "2028-02-27")).toEqual(["2028-03-01", "2028-03-01"]);
    });

    it("reads a German day-first date with German tense words, whatever English shares its month name", () => {
        // English `was` is a past cue, German `was` is "what": the German words decide.
        expect(windowOf("was habe ich am 3. April gemacht", "2026-03-10")).toEqual(["2025-04-03", "2025-04-03"]);
        expect(windowOf("was habe ich am 3. april vor", "2026-03-10")).toEqual(["2026-04-03", "2026-04-03"]);
        expect(windowOf("what did I do on 3 April", "2026-03-10")).toEqual(["2025-04-03", "2025-04-03"]);
    });

    it("crosses into the next year from December", () => {
        expect(windowOf("plans for next month", "2026-12-15")).toEqual(["2027-01-01", "2027-01-31"]);
        expect(windowOf("nächsten Monat", "2026-12-15")).toEqual(["2027-01-01", "2027-01-31"]);
        expect(windowOf("what is happening next week", "2026-12-30")).toEqual(["2027-01-04", "2027-01-10"]);
        expect(windowOf("goals for next year", "2026-12-31")).toEqual(["2027-01-01", "2027-12-31"]);
        expect(windowOf("what did I do last month", "2027-01-05")).toEqual(["2026-12-01", "2026-12-31"]);
    });

    it("prefers an ISO date to words", () => {
        expect(windowOf("yesterday, that is on 2026-11-26")).toEqual(["2026-11-26", "2026-11-26"]);
        expect(windowOf("tomorrow or on 2026-12-01")).toEqual(["2026-12-01", "2026-12-01"]);
    });

    it("reads every ISO date, and one span between two of them", () => {
        expect(windowOf("what is on 2026-12-03 or 2026-12-05")).toEqual([
            ["2026-12-03", "2026-12-03"],
            ["2026-12-05", "2026-12-05"],
        ]);
        expect(windowOf("what is on between 2026-12-03 and 2026-12-10")).toEqual(["2026-12-03", "2026-12-10"]);
        expect(windowOf("was steht zwischen 2026-12-03 und 2026-12-10 an")).toEqual(["2026-12-03", "2026-12-10"]);
        // The two named the other way round are the same days.
        expect(windowOf("between 2026-12-10 and 2026-12-03")).toEqual(["2026-12-03", "2026-12-10"]);
        expect(timeWindowOf("what is on between 2026-12-03 and 2026-12-10", TODAY)?.onlyTime).toBe(true);
        expect(timeWindowOf("was steht zwischen 2026-12-03 und 2026-12-10 an", TODAY)?.onlyTime).toBe(true);
    });

    it("reads an ISO date only of digits, its month 1 to 12", () => {
        // Neither is a month of 2026: the word phrase after them is read.
        expect(windowOf("what did the 2026-QA review find in May")).toEqual(["2026-05-01", "2026-05-31"]);
        expect(windowOf("ticket 2026-13 is due in May")).toEqual(["2026-05-01", "2026-05-31"]);
        expect(windowOf("the 2026-12-QA review in May")).toEqual(["2026-05-01", "2026-05-31"]);
        expect(windowOf("the 2026-QA notes")).toBeUndefined();
        expect(windowOf("the bills of 2026-10")).toEqual(["2026-10-01", "2026-10-31"]);
    });

    it.each([
        // `before` and `after` read the month as `in` does, except that a past cue never moves `before` a month to last
        // year: the days before this year's are past already.
        ["anything before December", [OPEN_START, "2026-11-30"]],
        ["what did I do before December", [OPEN_START, "2026-11-30"]],
        ["what did I do before May", [OPEN_START, "2026-04-30"]],
        ["what is planned before May", [OPEN_START, "2027-04-30"]],
        ["anything after December", ["2027-01-01", OPEN_END]],
        ["what did I do after May", ["2026-06-01", OPEN_END]],
        ["what did I do after December", ["2026-01-01", OPEN_END]],
        ["was ist vor Dezember", [OPEN_START, "2026-11-30"]],
        ["was ist nach Dezember", ["2027-01-01", OPEN_END]],
        // `since` reads back to the last such month, `until` ahead to the next: each runs to or from today.
        ["anything since May", ["2026-05-01", TODAY]],
        ["anything since December", ["2025-12-01", TODAY]],
        ["anything until May", [TODAY, "2027-05-31"]],
        ["anything until November", [TODAY, "2026-11-30"]],
        ["was war seit Mai", ["2026-05-01", TODAY]],
        ["was steht bis Mai an", [TODAY, "2027-05-31"]],
        ["since May last year", ["2025-05-01", TODAY]],
        ["until 3 December", [TODAY, "2026-12-03"]],
        // A day after an article: `the 3rd of June` is the bound, never a day of its own.
        ["what was before the 3rd of June", [OPEN_START, "2026-06-02"]],
        ["was war vor dem 3. Juni", [OPEN_START, "2026-06-02"]],
        ["was steht bis zum 3. Dezember an", [TODAY, "2026-12-03"]],
        // A year, and a time on the other side of today: never a span that ends before it starts.
        ["where did I live since 2023", ["2023-01-01", TODAY]],
        ["what did I do until May 2023", [OPEN_START, "2023-05-31"]],
        ["wo habe ich bis 2023 gewohnt", [OPEN_START, "2023-12-31"]],
        ["since 2027", ["2027-01-01", OPEN_END]],
        // A bare year after `before` and `after`, which lead no year of their own.
        ["what did I do before 2023", [OPEN_START, "2022-12-31"]],
        ["anything after 2023", ["2024-01-01", OPEN_END]],
        ["was war vor 2023", [OPEN_START, "2022-12-31"]],
        ["was ist nach 2023", ["2024-01-01", OPEN_END]],
        // An ISO date after a range word: the range, never the named day alone.
        ["what is on before 2026-12-03", [OPEN_START, "2026-12-02"]],
        ["anything since 2026-12", ["2026-12-01", OPEN_END]],
        ["anything since 2026-11", ["2026-11-01", TODAY]],
        ["was ist nach 2026-12-03", ["2026-12-04", OPEN_END]],
        ["was steht bis zum 2026-12-03 an", [TODAY, "2026-12-03"]],
    ])("reads %j as a range", (text, expected) => {
        expect(windowOf(text)).toEqual(expected);
    });

    it("keeps a range word before a time it does not bound as it was", () => {
        expect(windowOf("was habe ich vor drei Tagen gemacht")).toEqual(["2026-11-24", "2026-11-24"]);
        expect(windowOf("what is on before tomorrow")).toEqual(["2026-11-28", "2026-11-28"]);
        expect(windowOf("was steht bis morgen an")).toEqual(["2026-11-28", "2026-11-28"]);
        expect(windowOf("what is on the day after tomorrow")).toEqual(["2026-11-29", "2026-11-29"]);
    });

    it.each([
        ["what is planned for the last week of December", ["2026-12-25", "2026-12-31"]],
        ["the first week of May", ["2026-05-01", "2026-05-07"]],
        ["the last week in February 2028", ["2028-02-23", "2028-02-29"]],
        ["the last week of December last year", ["2025-12-25", "2025-12-31"]],
        ["was war in der letzten Woche im Dezember", ["2025-12-25", "2025-12-31"]],
        ["was steht Anfang Dezember an", ["2026-12-01", "2026-12-10"]],
        ["Mitte Juni", ["2026-06-11", "2026-06-20"]],
        ["Ende Mai", ["2026-05-21", "2026-05-31"]],
        ["Ende Februar 2028", ["2028-02-21", "2028-02-29"]],
        // The year as for the whole month: November ends after today, so it is this year's.
        ["was habe ich Anfang November vor", ["2026-11-01", "2026-11-10"]],
        ["was steht bis Ende Mai an", [TODAY, "2027-05-31"]],
        // `last` and `letzten` of a part are no past cue: the upcoming December's last week.
        ["what do I have the last week of December", ["2026-12-25", "2026-12-31"]],
        ["was habe ich in der letzten Woche im Dezember", ["2026-12-25", "2026-12-31"]],
    ])("reads part of a month in %j", (text, expected) => {
        expect(windowOf(text)).toEqual(expected);
    });

    it("gives a group's year to a dated day in it, and parts a group at a semicolon or a sentence end", () => {
        const may2024AndJune3 = [
            ["2024-05-01", "2024-05-31"],
            ["2024-06-03", "2024-06-03"],
        ];

        expect(windowOf("what did I do in May and June 3, 2024")).toEqual(may2024AndJune3);
        expect(windowOf("what did I do in May and the 3rd of June 2024")).toEqual(may2024AndJune3);
        expect(windowOf("was war im Mai und am 3. Juni 2024")).toEqual(may2024AndJune3);

        const mayAndJune2024 = [
            ["2026-05-01", "2026-05-31"],
            ["2024-06-01", "2024-06-30"],
        ];

        for (const text of [
            "what did I do in May; June 2024",
            "what did I do in May. June 2024",
            "what did I do in May? June 2024",
            "was war im Mai; Juni 2024",
        ]) {
            expect(windowOf(text), text).toEqual(mayAndJune2024);
        }

        // A comma and `and` still join; a relative year does not reach a month across a sentence end.
        expect(windowOf("what did I do in March, April and May 2024")).toHaveLength(3);
        expect(windowOf("what did I do in May; last year was different")).toEqual([
            ["2026-05-01", "2026-05-31"],
            ["2025-01-01", "2025-12-31"],
        ]);
    });

    it("reads a question of a range or part of a month alone as one about the time alone", () => {
        const only = (text: string) => timeWindowOf(text, TODAY)?.onlyTime === true;

        expect(
            [
                "anything before December",
                "was ist nach Dezember",
                "what is planned for the first week of December",
                "was steht Anfang Dezember an",
                "tomorrow?",
                "appointments tomorrow?",
                "Termine morgen?",
            ].map((text) => only(text)),
        ).toEqual([true, true, true, true, true, true, true]);
    });
});
