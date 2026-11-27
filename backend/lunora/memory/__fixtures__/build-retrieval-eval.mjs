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
// five persona details. Hand-written; `unseen` are questions about topics nobody has.
const { topics: TOPICS, unseen: UNSEEN } = JSON.parse(readFileSync(new URL("retrieval-eval-phrases.json", import.meta.url), "utf8"));

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
            const age = ageOf();

            add({
                ageDays: pinned ? round(200 + r() * 300, 1) : age,
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

    // Rows another version replaced, and rows past their end date: both keep their vectors, neither is a candidate.
    const chained = have.slice(0, 8).map((t, k) => [t, [1, 2, 4, 5][k % 4]]);

    chained.forEach(([t, a], k) => {
        const age = ageOf() + 120;
        const row = {
            ageDays: round(age, 1),
            createdDays: round(age + 5, 1),
            id: `${pid}-${TOPICS[t][0]}-a${a}-old`,
            tags: tags(t, a),
            text: TOPICS[t][2][a].replace("{d}", detail(t, 1)),
            type: TYPES[a],
        };

        add(k % 2 === 0 ? { ...row, supersededBy: `${pid}-${TOPICS[t][0]}-a${a}` } : { ...row, validUntil: dayString(NOW - (20 + k * 17) * 86400000) });
    });

    for (const t of have) {
        const a = (t + p) % 6;

        if (r() < 0.8)
            add({
                ageDays: ageOf() + 60,
                createdDays: ageOf() + 90,
                id: `${pid}-${TOPICS[t][0]}-exp${a}`,
                tags: tags(t, a),
                text: TOPICS[t][2][a].replace("{d}", detail(t, 3)),
                type: TYPES[a],
                validUntil: dayString(NOW - (10 + Math.floor(r() * 200)) * 86400000),
            });
    }

    // Rows of two bots: bot-a joins this user's chats as that bot, bot-b never does.
    for (const [bot, shift, count] of [
        ["bot-a", 2, 18 + p * 3],
        ["bot-b", 4, 24 + p * 4],
    ]) {
        for (let k = 0; k < count; k++) {
            const t = have[k % have.length];
            const a = (k + p) % 6;

            add({
                ageDays: ageOf(),
                botId: bot,
                createdDays: ageOf() + 20,
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

        add({
            ageDays: ageOf(),
            createdDays: ageOf() + 3,
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
        const t = have[(k * 3 + p) % have.length];
        const a = (k + p) % 6;

        q("single", TOPICS[t][3][a], { [t]: 1, [ASPECT0 + a]: 0.6 }, [`${pid}-${TOPICS[t][0]}-a${a}`], bot(k));
    }

    for (let k = 0; k < 6; k++) {
        const t = have[(k * 2 + p + 1) % have.length];
        const [a, b] = [(k + p) % 3, 3 + ((k + p) % 3)];

        q(
            "multi",
            `${TOPICS[t][3][a]} and also ${TOPICS[t][3][b]}`,
            { [t]: 1, [ASPECT0 + a]: 0.4, [ASPECT0 + b]: 0.4 },
            [`${pid}-${TOPICS[t][0]}-a${a}`, `${pid}-${TOPICS[t][0]}-a${b}`],
            bot(k + 1),
        );
    }

    events.slice(0, 6).forEach((t, k) => {
        const row = memories.find((m) => m.id === `${pid}-ev-${TOPICS[t][0]}`);
        const month =
            Object.keys(row.tags)
                .map(Number)
                .find((d) => d >= MONTH0 && d < NOISE0) - MONTH0;

        q("temporal", `what did I do about ${TOPICS[t][0]} in ${MONTHS[month]}`, { [t]: 1, [ASPECT0 + 3]: 0.6, [MONTH0 + month]: 0.6 }, [row.id], bot(k + 2));
    });

    chained.slice(0, 4).forEach(([t, a], k) => {
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

const fixture = {
    meta: {
        dimensions: 64,
        now: NOW,
        today: dayString(NOW),
        vectorTopK: 30,
        windowSize: 100,
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
