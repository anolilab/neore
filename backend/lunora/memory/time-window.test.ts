import { describe, expect, it } from "vitest";

import { localDayOf } from "./reflection-logic";
import { timeWindowOf } from "./time-window";

/** A Friday. */
const TODAY = "2026-11-27";

const windowOf = (text: string, today = TODAY): [string, string] | undefined => {
    const window = timeWindowOf(text, today);

    return window === undefined ? undefined : [window.start, window.end];
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
});
