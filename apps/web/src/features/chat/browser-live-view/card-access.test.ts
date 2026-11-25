import { describe, expect, it } from "vitest";

import type { AccessAnswer, AccessInput, CardAccess } from "./card-access";
import { cardAccess, upcomingGrantEnd } from "./card-access";

/** A status `running` or `none`, or an ask `elsewhere`: the caller reads the chat. */
const reads = (now: number, accessUntil?: number): AccessAnswer => {
    return { ...(accessUntil !== undefined && { accessUntil }), now, reads: true };
};

/** An ask `found`. */
const ask = (now: number, canResolve: boolean, accessUntil?: number): AccessAnswer => {
    return { ...reads(now, accessUntil), canResolve };
};

/** A status `denied`, or an ask `none`. */
const denied = (now: number): AccessAnswer => {
    return { now, reads: false };
};

interface Row {
    expected: Partial<CardAccess>;
    input: AccessInput;
    name: string;
}

const rows: Row[] = [
    { expected: { hidden: "pending", mayAnswer: false, memory: {} }, input: { memory: {} }, name: "a card that reads no status shows nothing of the site" },
    {
        expected: { behind: false, hidden: "pending", mayAnswer: false, memory: {} },
        input: { ask: [undefined, undefined], memory: {}, status: [undefined, undefined] },
        name: "before any answer, the card shows nothing of the site and offers no answer",
    },
    {
        expected: { behind: false, hidden: "pending", mayAnswer: false },
        input: { ask: [ask(5, true)], memory: {}, status: [undefined, undefined] },
        name: "an ask that may be answered shows nothing while the status has not answered",
    },
    {
        expected: { behind: false, hidden: "pending", mayAnswer: false },
        input: { ask: [undefined, undefined], memory: {}, status: [reads(4)] },
        name: "a status that reads the chat shows nothing while the ask the card reads has not answered",
    },
    {
        expected: { hidden: "pending", mayAnswer: false },
        input: { ask: [ask(5, true)], memory: {} },
        name: "a card that reads an ask but no status shows nothing of the site",
    },
    {
        expected: { hidden: "unreadable", mayAnswer: false, memory: { end: 6 } },
        input: { ask: [undefined], memory: {}, status: [denied(6)] },
        name: "a denied status hides the card while the ask has not answered, for the denial",
    },
    {
        expected: { hidden: undefined, mayAnswer: true },
        input: { ask: [ask(5, true)], memory: {}, status: [reads(4)] },
        name: "an open ask the caller may answer",
    },
    {
        expected: { hidden: undefined, mayAnswer: false },
        input: { ask: [reads(5)], memory: {}, status: [reads(4)] },
        name: "an ask of another chat (`elsewhere`) shows the page and offers no answer",
    },
    {
        expected: { hidden: undefined, mayAnswer: false },
        input: { memory: {}, status: [reads(4)] },
        name: "a card from before asks carried their reply reads no ask and offers no answer",
    },
    {
        expected: { hidden: "unreadable", mayAnswer: false, memory: { end: 6 } },
        input: { ask: [ask(5, true)], memory: {}, status: [denied(6)] },
        name: "a denied status hides the card",
    },
    {
        expected: { hidden: "unreadable", mayAnswer: false },
        input: { ask: [denied(5)], memory: {}, status: [reads(6)] },
        name: "an unreadable ask hides the card",
    },
    {
        expected: { behind: true, hidden: "unreadable", mayAnswer: false },
        input: { ask: [ask(25, true)], memory: {}, status: [denied(20)] },
        name: "a later ask read never undoes the status's denial (two replicas of the grant)",
    },
    {
        expected: { hidden: "unreadable" },
        input: { ask: [ask(15, true)], memory: { end: 20 }, status: [reads(15)] },
        name: "an end is kept after the answer that said so has left the cache",
    },
    {
        expected: { hidden: "unreadable", mayAnswer: false },
        input: { memory: {}, status: [reads(10), denied(20)] },
        name: "a delayed older push of a read does not undo its newer denial",
    },
    {
        expected: { hidden: "unreadable" },
        input: { memory: {}, status: [denied(20), reads(20)] },
        name: "on a tie within one read, a denial wins",
    },
    {
        expected: { hidden: "unreadable", mayAnswer: false },
        input: { ask: [ask(20, true)], memory: { end: 20 }, status: [reads(21)] },
        name: "an answer at the very moment of the end is not after it",
    },
    {
        expected: { hidden: "ended", mayAnswer: false, memory: { end: 10, grantEnd: 10, hiddenBy: "ended" } },
        input: { ask: [ask(6, true, 10)], memory: {}, serverPast: 10, status: [reads(5, 10)] },
        name: "a grant end the card's timer reached hides everything",
    },
    {
        expected: { hidden: "ended", mayAnswer: false, memory: { end: 10, grantEnd: 10 } },
        input: { ask: [ask(12, true, 10)], memory: {}, status: [reads(12, 10)] },
        name: "an answer naming a grant end its own time is past never affirms",
    },
    {
        expected: { behind: true, hidden: "ended", memory: { end: 10, grantEnd: 10 } },
        input: { ask: [ask(9, true, 10)], memory: {}, status: [reads(11, 100)] },
        name: "a grant end is known passed from a later answer's own time, with no timer",
    },
    {
        expected: { hidden: undefined, mayAnswer: true },
        input: {
            ask: [denied(12), ask(31, true, 100)],
            memory: { end: 12, grantEnd: 10 },
            status: [denied(12), reads(30, 100)],
        },
        name: "a renewal shows the card once both reads answer after the end",
    },
    {
        expected: { behind: true, hidden: "ended", mayAnswer: false },
        input: { ask: [ask(9, true, 10)], memory: { end: 10, grantEnd: 10 }, status: [reads(30, 100)] },
        name: "a renewed status alone shows nothing while the ask was last read before the end",
    },
    {
        expected: { hidden: "ended", memory: { end: 10, grantEnd: 10, hiddenBy: "ended" } },
        input: { memory: { end: 10, grantEnd: 10, hiddenBy: "ended" }, status: [reads(9, 10)] },
        name: "a status push sent before the grant's end and delivered after it does not show the card again",
    },
    {
        expected: { hidden: undefined, memory: { end: 10, grantEnd: 10 } },
        input: { memory: { end: 10, grantEnd: 10, hiddenBy: "ended" }, status: [reads(30)] },
        name: "a card that reads no ask shows again once a status from after the end says the caller reads the chat, with no browser",
    },
    {
        expected: { hidden: "ended", mayAnswer: false },
        input: { ask: [], memory: { end: 10, grantEnd: 10 }, status: [reads(30, 100)] },
        name: "after an end, a read not answered since holds the card back",
    },
    {
        // CodeRabbit: the end was noticed on reads at `now: 0`; an old writer grant's ask read (`now: 9`, ended at 10)
        // comes late after a reader grant's renewal.
        expected: { mayAnswer: false },
        input: { ask: [undefined, ask(9, true, 10)], memory: { end: 10, grantEnd: 10 }, status: [reads(0, 10), reads(30, 100)] },
        name: "a delayed ask read from before the grant's end never restores answers",
    },
    {
        expected: { hidden: undefined, mayAnswer: false },
        input: { ask: [ask(31, false, 100), ask(9, true, 10)], memory: { end: 10, grantEnd: 10 }, status: [reads(30, 100)] },
        name: "after a renewal to a reader grant, the page shows and the answers stay hidden",
    },
    {
        expected: { hidden: undefined, mayAnswer: false },
        input: { ask: [ask(31, true, 100), ask(31, false, 100)], memory: {}, status: [reads(30, 100)] },
        name: "on a tie within the ask's read, every answer must say the caller may answer",
    },
    {
        // qodo: the live query's refetch hands back its last push (a denial) after a one-shot read saw the renewal.
        expected: { hidden: undefined, mayAnswer: true },
        input: { ask: [denied(20), ask(31, true, 100)], memory: { end: 20 }, status: [denied(20), reads(30, 100)] },
        name: "a replayed denial from before a renewal does not hide it again after a refocus",
    },
    {
        // qodo: a one-shot read sent before the browser opened answers after the push that it did.
        expected: { hidden: undefined, mayAnswer: true },
        input: { ask: [ask(11, true)], memory: { end: 7 }, status: [reads(10), denied(5)] },
        name: "a delayed older answer of a read, a denial too, does not decide over its newer one",
    },
    {
        expected: { hidden: undefined, mayAnswer: true },
        input: { ask: [ask(0, true, 10), ask(5, true, 600)], memory: {}, serverPast: 10, status: [reads(0, 10), reads(5, 600)] },
        name: "a grant renewed before its end is not ended by the subscription's last push, which still names the old end",
    },
    {
        expected: { hidden: "unreadable", memory: { end: 50, grantEnd: 10, hiddenBy: "unreadable" } },
        input: { memory: { end: 10, grantEnd: 10 }, status: [denied(50)] },
        name: "a lock after a renewal says the check cannot be read, not that access ended",
    },
    {
        expected: { hidden: "ended", memory: { end: 11, grantEnd: 10, hiddenBy: "ended" } },
        input: { ask: [denied(11)], memory: { end: 10, grantEnd: 10, hiddenBy: "ended" }, status: [denied(11)] },
        name: "the reads after a grant's end, which deny, still say access ended",
    },
    {
        expected: { hidden: "unreadable", memory: { end: 10, grantEnd: 10, hiddenBy: "unreadable" } },
        input: { ask: [ask(5, true, 10)], memory: { end: 8, hiddenBy: "unreadable" }, serverPast: 10, status: [denied(8)] },
        name: "a grant end reached after a denial does not change why the card is hidden",
    },
];

describe(cardAccess, () => {
    it.each(rows)("$name", ({ expected, input }: Row) => {
        expect(cardAccess(input)).toMatchObject(expected);
    });
});

describe(upcomingGrantEnd, () => {
    it.each([
        { expected: undefined, input: { memory: {}, status: [reads(5)] }, name: "no grant: nothing to wait for" },
        { expected: 10, input: { ask: [ask(6, true, 12)], memory: {}, status: [reads(5, 10)] }, name: "the earliest end" },
        { expected: 100, input: { memory: { grantEnd: 10 }, status: [reads(5, 10), reads(30, 100)] }, name: "an end already passed is not waited for" },
        { expected: undefined, input: { ask: [ask(9, true, 10)], memory: {}, status: [reads(11)] }, name: "an end a later answer is past" },
    ])("$name", ({ expected, input }: { expected: number | undefined; input: Omit<AccessInput, "serverPast">; name: string }) => {
        expect(upcomingGrantEnd(input)).toBe(expected);
    });
});
