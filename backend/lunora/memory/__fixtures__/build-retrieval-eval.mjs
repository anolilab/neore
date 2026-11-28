// @ts-nocheck: a build script for a data file, run by hand with node.
// Builds retrieval-eval.json. Run: node backend/lunora/memory/__fixtures__/build-retrieval-eval.mjs
// The phrase bank below is written by hand and everything is synthetic; the script only combines it, with a seeded
// random generator, into personas, memories and labelled queries. The JSON it writes is the committed fixture.
import { readFileSync, writeFileSync } from "node:fs";

// Vector layout (64 dims): 0-15 topics, 16-21 topics nobody has, 22-27 aspects, 28 shared background, 29-40 month, 41-63 noise.
const COMMON = 28;
const MONTH0 = 29;
const NOISE0 = 41;
const ASPECT0 = 22;
const TYPES = ["identity", "preference", "context", "activity", "experience", "context"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// label, event phrase ({d} = the persona's detail), six facts (one per aspect), six questions that paraphrase them,
// five persona details. Hand-written; `unseen` are questions about topics nobody has; `exact` are facts holding an exact
// token, a question naming it, and a question naming a token nobody has.
const { exact: EXACT, topics: TOPICS, unseen: UNSEEN } = JSON.parse(readFileSync(new URL("retrieval-eval-phrases.json", import.meta.url), "utf8"));

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const hash = (s) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const rng = (seed) => {
    let a = hash(seed);

    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);

        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const between = (r, lo, hi) => round(lo + r() * (hi - lo), 0);
const dayString = (ms) => new Date(ms).toISOString().slice(0, 10);
const RANGES = {
    activity: [60, 85, 25, 50],
    context: [65, 90, 40, 70],
    experience: [65, 90, 35, 65],
    identity: [80, 95, 70, 90],
    preference: [70, 90, 55, 75],
};
const FILLERS = [
    "Mentioned {l} in passing during a chat",
    "Brought up {l} while talking about something else",
    "Asked a quick question about {l} once",
    "Said {l} came up again with friends",
];
const PERSONAS = 5;
const personas = [];
const queries = [];

for (let p = 0; p < PERSONAS; p++) {
    const r = rng(`persona-${p}`);
    const pid = `p${p + 1}`;
    const missing = new Set([p, (p + 5) % 16, (p * 3 + 7) % 16, ...(p % 2 ? [(p + 11) % 16] : [])]);
    const have = TOPICS.map((_, i) => i).filter((i) => !missing.has(i));
    const memories = [];
    const detail = (t, shift = 0) => TOPICS[t][4][(p + shift) % 5];
    const tags = (t, a, extra = {}) => {
        const o = { [t]: 1, [ASPECT0 + a]: 0.6, [COMMON]: 0.5, ...extra };

        o[NOISE0 + between(r, 0, 22)] = 0.3;
        o[NOISE0 + between(r, 0, 22)] = 0.3;

        return o;
    };
    const add = (row) => {
        const [cl, ch, il, ih] = RANGES[row.type] ?? RANGES.context;

        // A row is created before it is last confirmed, and neither is after the fixture's day (ages count back from `NOW`).
        if (!(row.ageDays >= 0 && row.createdDays >= row.ageDays)) throw new Error(`impossible timestamps on ${row.id}`);

        const lowSignal = row.low === true;

        delete row.low;
        memories.push({
            confidence: row.confidence ?? (lowSignal ? between(r, 45, 60) : between(r, cl, ch)),
            importance: row.importance ?? (lowSignal ? between(r, 15, 30) : between(r, il, ih)),
            ...row,
        });
    };
    const ageOf = () => round(r() ** 2 * 400 + 2, 1);

    for (const t of have) {
        for (let a = 0; a < 6; a++) {
            const pinned = a === 0 && (t + p) % 4 === 0;
            const age = pinned ? round(200 + r() * 300, 1) : ageOf();

            add({
                ageDays: age,
                createdDays: round(age + 1 + r() * 20, 1),
                id: `${pid}-${TOPICS[t][0]}-a${a}`,
                noVector: r() < 0.07 || undefined,
                pinned: pinned || undefined,
                tags: tags(t, a),
                text: TOPICS[t][2][a].replace("{d}", detail(t)),
                type: TYPES[a],
            });
        }
    }

    // Events with a date: the month is in the text, the vector, and `eventStart`.
    const events = have.slice(0, 10 + p * 2);

    events.forEach((t, k) => {
        const month = (k * 5 + p * 3) % 12;
        const date = Date.UTC(2026, month, 3 + ((k * 7 + p) % 24), 9);
        const confirmed = date < NOW ? Math.max(1, (NOW - date) / 86400000 - 1) : between(r, 1, 20);

        add({
            ageDays: round(confirmed, 1),
            createdDays: round(confirmed + 1, 1),
            eventStart: dayString(date),
            id: `${pid}-ev-${TOPICS[t][0]}`,
            tags: tags(t, 3, { [MONTH0 + month]: 0.6 }),
            text: `On ${Number(dayString(date).slice(8))} ${MONTHS[month]} 2026 the user ${TOPICS[t][1].replace("{d}", detail(t, 2))}`,
            type: "activity",
        });
    });

    // Topics the labelled queries ask about; the rest only carry rows that must not be mistaken for an answer.
    const core = have.slice(0, -4);

    // An older version of a fact: replaced (`supersededBy`), past its end date, or still active but confirmed longer ago.
    // The first two keep their vectors and are never candidates; the third is, and only the newest is labelled.
    const chained = core.slice(0, 8).map((t, k) => [t, [1, 2, 4, 5][k % 4]]);

    chained.forEach(([t, a], k) => {
        const age = memories.find((m) => m.id === `${pid}-${TOPICS[t][0]}-a${a}`).ageDays + 120 + r() * 60;
        const row = {
            ageDays: round(age, 1),
            createdDays: round(age + 5, 1),
            id: `${pid}-${TOPICS[t][0]}-a${a}-old`,
            tags: tags(t, a),
            text: TOPICS[t][2][a].replace("{d}", detail(t, 1)),
            type: TYPES[a],
        };

        if (k % 3 === 0) add({ ...row, supersededBy: `${pid}-${TOPICS[t][0]}-a${a}` });
        else if (k % 3 === 1) add({ ...row, validUntil: dayString(NOW - (20 + k * 17) * 86400000) });
        else add(row);
    });

    for (const t of have) {
        const a = (t + p) % 6;

        if (r() < 0.8) {
            const age = ageOf();

            add({
                ageDays: age + 60,
                createdDays: age + 90,
                id: `${pid}-${TOPICS[t][0]}-exp${a}`,
                tags: tags(t, a),
                text: TOPICS[t][2][a].replace("{d}", detail(t, 3)),
                type: TYPES[a],
                validUntil: dayString(NOW - (10 + Math.floor(r() * 200)) * 86400000),
            });
        }
    }

    // Facts with an end date still ahead (the last one ends today): in effect, so they are candidates.
    have.slice(-4).forEach((t, k) => {
        const a = (t + p) % 6;
        const age = ageOf();

        add({
            ageDays: age,
            createdDays: age + 5,
            id: `${pid}-${TOPICS[t][0]}-cur${a}`,
            tags: tags(t, a),
            text: TOPICS[t][2][a].replace("{d}", detail(t, 3)),
            type: TYPES[a],
            validUntil: dayString(NOW + k * 9 * 86400000),
        });
    });

    // Rows of two bots: bot-a joins this user's chats as that bot, bot-b never does.
    for (const [bot, shift, count] of [
        ["bot-a", 2, 18 + p * 3],
        ["bot-b", 4, 24 + p * 4],
    ]) {
        for (let k = 0; k < count; k++) {
            const t = have[k % have.length];
            const a = (k + p) % 6;

            const age = ageOf();

            add({
                ageDays: age,
                botId: bot,
                createdDays: age + 20,
                id: `${pid}-${bot}-${TOPICS[t][0]}-${k}`,
                tags: tags(t, a),
                text: TOPICS[t][2][a].replace("{d}", detail(t, shift)),
                type: TYPES[a],
            });
        }
    }

    // Low-signal rows that only brush a topic.
    for (let k = 0; k < 40 + p * 12; k++) {
        const t = have[(k * 3 + p) % have.length];

        const age = ageOf();

        add({
            ageDays: age,
            createdDays: age + 3,
            id: `${pid}-fill-${TOPICS[t][0]}-${k}`,
            low: true,
            noVector: r() < 0.1 || undefined,
            tags: tags(t, 3),
            text: `${FILLERS[k % 4].replace("{l}", TOPICS[t][0])}`,
            type: k % 3 === 0 ? "activity" : "context",
        });
    }

    personas.push({ botId: "bot-a", id: pid, memories, userId: `user-${pid}` });

    // Queries
    const q = (category, text, qtags, expected, extra = {}) => {
        const o = { ...qtags, [COMMON]: 0.5 };

        o[NOISE0 + between(r, 0, 22)] = 0.3;
        queries.push({ category, expected, id: `${pid}-${category}-${queries.length}`, persona: pid, tags: o, text, ...extra });
    };
    const bot = (k) => (k % 3 === 0 ? { asBot: "bot-a" } : {});

    for (let k = 0; k < 10; k++) {
        const t = core[(k * 3 + p) % core.length];
        const a = (k + p) % 6;

        q("single", TOPICS[t][3][a], { [t]: 1, [ASPECT0 + a]: 0.6 }, [`${pid}-${TOPICS[t][0]}-a${a}`], bot(k));
    }

    for (let k = 0; k < 6; k++) {
        const t = core[(k * 2 + p + 1) % core.length];
        const [a, b] = [(k + p) % 3, 3 + ((k + p) % 3)];

        q(
            "multi",
            `${TOPICS[t][3][a]} and also ${TOPICS[t][3][b]}`,
            { [t]: 1, [ASPECT0 + a]: 0.4, [ASPECT0 + b]: 0.4 },
            [`${pid}-${TOPICS[t][0]}-a${a}`, `${pid}-${TOPICS[t][0]}-a${b}`],
            bot(k + 1),
        );
    }

    // Past-tense questions ("what did I do ...") ask only about events on or before the fixture's day; later events stay
    // in the data as rows that must not be answers to them.
    events
        .filter((t) => memories.find((m) => m.id === `${pid}-ev-${TOPICS[t][0]}`).eventStart <= dayString(NOW))
        .slice(0, 6)
        .forEach((t, k) => {
            const row = memories.find((m) => m.id === `${pid}-ev-${TOPICS[t][0]}`);
            const month =
                Object.keys(row.tags)
                    .map(Number)
                    .find((d) => d >= MONTH0 && d < NOISE0) - MONTH0;

            q(
                "temporal",
                `what did I do about ${TOPICS[t][0]} in ${MONTHS[month]}`,
                { [t]: 1, [ASPECT0 + 3]: 0.6, [MONTH0 + month]: 0.6 },
                [row.id],
                bot(k + 2),
            );
        });

    [0, 1, 2, 5]
        .map((i) => chained[i])
        .forEach(([t, a], k) => {
            q("update", TOPICS[t][3][a], { [t]: 1, [ASPECT0 + a]: 0.6 }, [`${pid}-${TOPICS[t][0]}-a${a}`], bot(k));
        });

    for (let k = 0; k < 4; k++) {
        if (k < 2) {
            const [text, dim] = UNSEEN[(p * 2 + k) % UNSEEN.length];

            q("abstain", text, { [16 + dim]: 1, [ASPECT0 + ((k + p) % 6)]: 0.6 }, [], bot(k));
        } else {
            const t = [...missing][k % missing.size];

            q("abstain", TOPICS[t][3][(k + p) % 6], { [t]: 1, [ASPECT0 + ((k + p) % 6)]: 0.6 }, [], bot(k));
        }
    }
}

// Exact tokens (codes, names, rare words), a second pass with its own seed so the rows above stay as they were. Each
// fact is old (outside the newest-100 window) and embedded on a dimension of its own (64 + entry); its question embeds
// on a topic nobody has, so the vector search misses it by construction and only the keyword search can find it. The
// same text also sits on a superseded, an expired or another bot's row, which must never be the answer. The negative
// questions name a token nobody has, often beside words a real fact holds.
const EXACT0 = 64;

for (const [p, persona] of personas.entries()) {
    const r = rng(`exact-${p}`);
    const pid = persona.id;
    const noise = (o) => {
        o[NOISE0 + between(r, 0, 22)] = 0.3;
        o[NOISE0 + between(r, 0, 22)] = 0.3;

        return o;
    };
    const entries = [0, 1, 2, 3].map((i) => (p * 2 + i) % EXACT.length);

    entries.forEach((j, k) => {
        const [text, question] = EXACT[j];
        const id = `${pid}-exact-${j}`;
        const created = round(380 + r() * 40, 1);
        const row = { createdDays: created, tags: noise({ [EXACT0 + j]: 1, [COMMON]: 0.5 }), text, type: "context" };

        persona.memories.push({ ageDays: round(30 + r() * 300, 1), confidence: between(r, 65, 90), id, importance: between(r, 40, 70), ...row });

        const shadow = { ageDays: round(created - 1, 1), confidence: between(r, 65, 90), id: `${id}-shadow`, importance: between(r, 40, 70), ...row };

        persona.memories.push(
            [
                { ...shadow, supersededBy: id },
                { ...shadow, validUntil: dayString(NOW - (30 + k * 11) * 86400000) },
                { ...shadow, botId: "bot-b" },
            ][k % 3],
        );
        queries.push({
            category: "exact",
            expected: [id],
            id: `${pid}-exact-${queries.length}`,
            persona: pid,
            tags: noise({ [16 + (j % 6)]: 1, [COMMON]: 0.5 }),
            text: question,
            ...(k % 3 === 0 && { asBot: "bot-a" }),
        });
    });

    for (const j of entries.slice(0, 2)) {
        queries.push({
            category: "abstain",
            expected: [],
            id: `${pid}-abstain-${queries.length}`,
            persona: pid,
            tags: noise({ [16 + (j % 6)]: 1, [COMMON]: 0.5 }),
            text: EXACT[j][2],
        });
    }
}

// Explicit times ("tomorrow", "last week", "im Dezember", "in 2023", "2026-11-22"), a third pass with its own seed. It
// runs on a sixth persona, a copy of the first with these rows added, so no row of the queries above changes. Each row
// is an event with a date, a fact with an end date, or a fact with none; each theme has a dimension of its own (DATED0 +
// theme), and an event carries its month as above. A question with a topic embeds on it; one about a time alone
// ("what is coming up tomorrow") embeds on an aspect only, since an embedding does not know which day "tomorrow" is.
// `window` is the time each question asks about, written here as days, never read by the parser under test: the
// expected rows are every event in it (of the question's theme, when it names one), or the ids it lists.
const DATED0 = EXACT0 + EXACT.length;
const THEMES = { appointments: 1, contracts: 5, home: 0, social: 4, travel: 2, work: 3 };
const DAY = 86400000;
const TODAY = dayString(NOW);
const ago = (days) => dayString(NOW - days * DAY);

{
    const r = rng("dated");
    const source = personas[0];
    const pid = "p6";
    const noise = (o) => {
        o[NOISE0 + between(r, 0, 22)] = 0.3;
        o[NOISE0 + between(r, 0, 22)] = 0.3;

        return o;
    };
    // A copied event after the fixture's day is worded as planned, so a question about what is ahead is not answered by
    // a row that says it already happened. The first persona keeps its rows as they are.
    const PLANNED = { "p1-ev-hiking": "On 4 December 2026 the user leads a group walk to the lake circuit" };
    const memories = source.memories.map((m) => {
        if (m.eventStart > dayString(NOW) && PLANNED[m.id] === undefined) throw new Error(`no planned wording for ${m.id}`);

        return {
            ...m,
            id: m.id.replace(/^p1-/u, `${pid}-`),
            ...(m.supersededBy && { supersededBy: m.supersededBy.replace(/^p1-/u, `${pid}-`) }),
            ...(PLANNED[m.id] && { text: PLANNED[m.id] }),
        };
    });
    const dims = (theme, aspect, eventStart) => {
        const topic = typeof theme === "number" ? theme : DATED0 + THEMES[theme];

        return { [topic]: 1, [ASPECT0 + aspect]: 0.6, [COMMON]: 0.5, ...(eventStart && { [MONTH0 + Number(eventStart.slice(5, 7)) - 1]: 0.6 }) };
    };
    const topic = (label) => TOPICS.findIndex(([name]) => name === label);
    // [id, theme, text, eventStart, eventEnd, validUntil]; an event ahead was mentioned in the last days, one past around its day.
    const ROWS = [
        ["dentist-tomorrow", "appointments", "Dentist appointment on 28 November 2026 at nine", "2026-11-28"],
        ["dentist-october", "appointments", "Dentist appointment on 14 October 2026 for a cleaning", "2026-10-14"],
        ["haircut-today", "appointments", "Haircut booked for 27 November 2026 after work", TODAY],
        ["dinner-yesterday", "social", "Had dinner with Mara at the Thai place on 26 November 2026", ago(1)],
        ["dinner-november", "social", "Had dinner with Jonas at the pizzeria on 5 November 2026", "2026-11-05"],
        ["christmas", "social", "Spends 24 December 2026 at the parents' house", "2026-12-24"],
        ["race", topic("running"), "Ran a 10 km race through the old town on 22 November 2026", "2026-11-22"],
        ["tasting", topic("coffee"), "Went to a coffee tasting with light roasts on 22 November 2026", ago(5)],
        ["tasting-september", topic("coffee"), "Went to a coffee tasting of espresso blends on 1 September 2026", "2026-09-01"],
        ["lesson-soon", topic("guitar"), "Has a guitar lesson on fingerpicking on 30 November 2026", "2026-11-30"],
        ["lesson-november", topic("guitar"), "Had a guitar lesson on barre chords on 2 November 2026", "2026-11-02"],
        ["offsite", "work", "Team offsite in the mountains planned for 3 December 2026", "2026-12-03"],
        ["offsite-june", "work", "Team offsite at the lake on 10 June 2026", "2026-06-10"],
        ["flight", "travel", "Flight to Lisbon on 18 December 2026", "2026-12-18"],
        ["kyoto", "travel", "Travelled to Kyoto in May 2023", "2023-05-10", "2023-05-20"],
        ["oslo", "travel", "Travelled to Oslo in May 2025", "2025-05-08", "2025-05-12"],
        ["porto", "travel", "Flight to Porto on 12 March 2026", "2026-03-12"],
        ["leipzig", "home", "Lived in a flat in Leipzig", "2021-04-01", "2024-02-29"],
        ["bremen", "home", "Lived in a shared flat in Bremen", "2016-09-01", "2021-03-31"],
        ["hamburg", "home", "Lives in a flat in Hamburg"],
        ["parking", "contracts", "Rents a parking spot near the flat until 31 March 2027", undefined, undefined, "2027-03-31"],
        ["gym", "contracts", "Gym membership with a parking spot runs until 30 November 2026", undefined, undefined, "2026-11-30"],
    ];

    for (const [name, theme, text, eventStart, eventEnd, validUntil] of ROWS) {
        const ahead = (eventStart ?? TODAY) >= TODAY;
        const age = ahead ? between(r, 1, 10) : round(Math.max(1, (NOW - Date.parse(eventEnd ?? eventStart ?? ago(200))) / DAY), 1);

        memories.push({
            ageDays: age,
            confidence: between(r, 70, 90),
            createdDays: round(age + 1, 1),
            ...(eventStart && { eventStart }),
            ...(eventEnd && { eventEnd }),
            id: `${pid}-dated-${name}`,
            importance: between(r, 40, 70),
            tags: noise(dims(theme, theme === "home" ? 4 : ahead ? 5 : 3, eventStart)),
            text,
            type: theme === "home" || theme === "contracts" ? "context" : "activity",
            ...(validUntil && { validUntil }),
        });
    }

    personas.push({ ...source, id: pid, memories, userId: `user-${pid}` });

    const LAST_WEEK = { end: "2026-11-22", start: "2026-11-16" };
    const NEXT_WEEK = { end: "2026-12-06", start: "2026-11-30" };
    const DECEMBER = { end: "2026-12-31", start: "2026-12-01" };
    const day = (at) => {
        return { end: at, start: at };
    };
    // [text, window, embedding (theme or topic, aspect, month), expected ids or undefined for every event in the window]
    const QUESTIONS = [
        ["what is coming up tomorrow", day("2026-11-28"), [undefined, 5]],
        ["was steht morgen an", day("2026-11-28"), [undefined, 5]],
        ["what do I have on today", day(TODAY), [undefined, 5]],
        ["was habe ich heute vor", day(TODAY), [undefined, 5]],
        ["who did I have dinner with yesterday", day(ago(1)), ["social", 3]],
        ["mit wem war ich gestern essen", day(ago(1)), ["social", 3]],
        ["what did I do last week", LAST_WEEK, [undefined, 3]],
        ["was habe ich letzte Woche gemacht", LAST_WEEK, [undefined, 3]],
        ["what is happening next week", NEXT_WEEK, [undefined, 5]],
        ["was ist nächste Woche los", NEXT_WEEK, [undefined, 5]],
        ["what are my plans for December", DECEMBER, [undefined, 5, 11]],
        ["was habe ich im Dezember vor", DECEMBER, [undefined, 5, 11]],
        ["what is planned for 3 December", day("2026-12-03"), [undefined, 5, 11]],
        ["was ist am 3. Dezember geplant", day("2026-12-03"), [undefined, 5, 11]],
        ["what was I doing on 2026-11-22", day("2026-11-22"), [undefined, 3, 10]],
        ["what guitar lesson do I have in 3 days", day("2026-11-30"), [topic("guitar"), 5], ["lesson-soon"]],
        ["welche Gitarrenstunde habe ich in 3 Tagen", day("2026-11-30"), [topic("guitar"), 5], ["lesson-soon"]],
        ["what coffee tasting did I go to 5 days ago", day(ago(5)), [topic("coffee"), 3], ["tasting"]],
        ["bei welchem Kaffee Tasting war ich vor 5 Tagen", day(ago(5)), [topic("coffee"), 3], ["tasting"]],
        ["where did I travel in May 2023", { end: "2023-05-31", start: "2023-05-01" }, ["travel", 3, 4], ["kyoto"]],
        ["wohin bin ich im Mai 2023 gereist", { end: "2023-05-31", start: "2023-05-01" }, ["travel", 3, 4], ["kyoto"]],
        ["where was I living in 2023", { end: "2023-12-31", start: "2023-01-01" }, ["home", 4], ["leipzig"]],
        ["wo habe ich im Jahr 2023 gewohnt", { end: "2023-12-31", start: "2023-01-01" }, ["home", 4], ["leipzig"]],
        ["do I still have a parking spot next month", DECEMBER, ["contracts", 5], ["parking"]],
        ["habe ich nächsten Monat noch einen Parkplatz", DECEMBER, ["contracts", 5], ["parking"]],
    ];
    const inWindow = (m, { end, start }) => m.eventStart !== undefined && !m.supersededBy && m.eventStart <= end && (m.eventEnd ?? m.eventStart) >= start;

    for (const [text, window, [theme, aspect, month], ids] of QUESTIONS) {
        const tags = noise({
            ...(theme !== undefined && { [typeof theme === "number" ? theme : DATED0 + THEMES[theme]]: 1 }),
            [ASPECT0 + aspect]: 0.6,
            [COMMON]: 0.5,
            ...(month !== undefined && { [MONTH0 + month]: 0.6 }),
        });
        const expected = ids?.map((name) => `${pid}-dated-${name}`) ?? memories.filter((m) => !m.botId && inWindow(m, window)).map((m) => m.id);

        queries.push({ category: "dated", expected, id: `${pid}-dated-${queries.length}`, persona: pid, tags, text, window });
    }

    // Questions that name a time but ask about something nobody mentioned: no event of that time is their answer.
    const NEXT_DAY = day("2026-11-28");
    const ABSTAIN = [
        ["what did I do about skydiving in May", { end: "2026-05-31", start: "2026-05-01" }, 0, 3, 4],
        ["draft an email saying I am away next week", NEXT_WEEK, 1, 5],
        ["schreib eine Mail, dass ich nächste Woche nicht da bin", NEXT_WEEK, 1, 5],
        ["what should I cook today", day(TODAY), 2, 5],
        ["was koche ich heute", day(TODAY), 2, 5],
        ["what is the weather like tomorrow", NEXT_DAY, 3],
        ["wie wird das Wetter morgen", NEXT_DAY, 3],
    ];

    for (const [text, window, unseen, aspect, month] of ABSTAIN) {
        const tags = noise({
            [16 + unseen]: 1,
            ...(aspect !== undefined && { [ASPECT0 + aspect]: 0.6 }),
            [COMMON]: 0.5,
            ...(month !== undefined && { [MONTH0 + month]: 0.6 }),
        });

        queries.push({ category: "abstain", expected: [], id: `${pid}-abstain-${queries.length}`, persona: pid, tags, text, window });
    }

    // Phrasings read since the `dated` questions above, labelled as they are and reported as `datedPhrases`: a short
    // question of a time alone, two ISO dates and the days between them, part of a month, and a range open at its
    // start. Added last, so every row and question before them draws the same random numbers.
    const PHRASES = [
        ["tomorrow?", day("2026-11-28"), [undefined, 5]],
        ["morgen?", day("2026-11-28"), [undefined, 5]],
        ["appointments tomorrow?", day("2026-11-28"), ["appointments", 5]],
        ["Termine morgen?", day("2026-11-28"), ["appointments", 5]],
        ["what is on between 2026-12-03 and 2026-12-10", { end: "2026-12-10", start: "2026-12-03" }, [undefined, 5, 11]],
        ["was steht zwischen 2026-12-03 und 2026-12-10 an", { end: "2026-12-10", start: "2026-12-03" }, [undefined, 5, 11]],
        ["what is planned for the first week of December", { end: "2026-12-07", start: "2026-12-01" }, [undefined, 5, 11]],
        ["was steht Anfang Dezember an", { end: "2026-12-10", start: "2026-12-01" }, [undefined, 5, 11]],
        ["was steht Mitte Dezember an", { end: "2026-12-20", start: "2026-12-11" }, [undefined, 5, 11]],
        ["where did I live until March 2021", { end: "2021-03-31", start: "0000-01-01" }, ["home", 4], ["bremen"]],
        ["wo habe ich bis März 2021 gewohnt", { end: "2021-03-31", start: "0000-01-01" }, ["home", 4], ["bremen"]],
    ];

    for (const [text, window, [theme, aspect, month], ids] of PHRASES) {
        const tags = noise({
            ...(theme !== undefined && { [DATED0 + THEMES[theme]]: 1 }),
            [ASPECT0 + aspect]: 0.6,
            [COMMON]: 0.5,
            ...(month !== undefined && { [MONTH0 + month]: 0.6 }),
        });
        const expected = ids?.map((name) => `${pid}-dated-${name}`) ?? memories.filter((m) => !m.botId && inWindow(m, window)).map((m) => m.id);

        queries.push({ category: "dated", expected, id: `${pid}-phrase-${queries.length}`, persona: pid, tags, text, window });
    }
}

const fixture = {
    meta: {
        dimensions: DATED0 + Object.keys(THEMES).length,
        now: NOW,
        today: dayString(NOW),
    },
    personas,
    queries,
};

// One memory per line keeps the diff of a regenerated fixture reviewable.
const lines = [
    "{",
    `  "meta": ${JSON.stringify(fixture.meta)},`,
    '  "personas": [',
    ...personas.map(
        (persona, i) =>
            `    {\n      "botId": "${persona.botId}",\n      "id": "${persona.id}",\n      "memories": [\n${persona.memories.map((m) => `        ${JSON.stringify(m)}`).join(",\n")}\n      ],\n      "userId": "${persona.userId}"\n    }${i < personas.length - 1 ? "," : ""}`,
    ),
    "  ],",
    '  "queries": [',
    queries.map((x) => `    ${JSON.stringify(x)}`).join(",\n"),
    "  ]",
    "}",
    "",
];

writeFileSync(new URL("retrieval-eval.json", import.meta.url), lines.join("\n"));
console.log(
    personas.map((x) => x.memories.length),
    queries.length,
);
