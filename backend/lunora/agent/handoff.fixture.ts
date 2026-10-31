/**
 * A long working thread for the handoff tests, generated from a fixed seed so the budget measured on it
 * (`handoff.test.ts`) is the same on every run.
 */
import type { HandoffTurn } from "./handoff";

/** A small deterministic generator, so the fixture is the same on every run. */
const generator = (seed: number) => () => {
    seed = Math.trunc(seed + 0x6d_2b_79_f5);
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);

    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

const WORDS =
    "add api auth backend branch build cache call client code config context data debug deploy error field file fix function handler index input job key lint log model module output page patch query queue read route schema session shard test token type update user value write".split(
        " ",
    );

/**
 * A developer's long working thread, newest last: 300 messages, user prompts mostly short (60%) with the rest
 * a paragraph or a pasted log, assistant replies mostly a few paragraphs with a tenth of them code-heavy and
 * up to 6,000 characters. About 64k tokens in all at 4 characters each.
 */
export const longThreadFixture = (): HandoffTurn[] => {
    const next = generator(2026);
    const words = (count: number) => Array.from({ length: count }, () => WORDS[Math.floor(next() * WORDS.length)]).join(" ");
    const between = (low: number, high: number) => Math.floor(low + next() * (high - low));
    const turns: HandoffTurn[] = [];

    for (let index = 0; index < 300; index += 1) {
        const roll = next();

        if (index % 2 === 0) {
            turns.push({ role: "user", text: words(roll < 0.6 ? between(4, 30) : between(40, 220)) });
        } else if (roll < 0.1) {
            turns.push({
                role: "assistant",
                text: `${words(between(30, 80))}\n\`\`\`ts\n${Array.from({ length: between(40, 110) }, () => `const ${words(1)} = ${words(2).replace(" ", "(")};`).join("\n")}\n\`\`\``,
            });
        } else {
            turns.push({ role: "assistant", text: words(roll < 0.5 ? between(40, 120) : between(120, 520)) });
        }
    }

    return turns;
};
