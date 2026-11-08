import { describe, expect, it } from "vitest";

import { CHOICE_AHEAD_ALLOWANCE_MS, snoozeChoiceStamp } from "./thread-state-logic";

describe(snoozeChoiceStamp, () => {
    const now = 1_000_000;

    it("keeps a client's stamp within the allowance, caps one further ahead, and stamps a missing one with the server's time", () => {
        expect(snoozeChoiceStamp(now + 5000, now)).toBe(now + 5000);
        // A clock an hour fast cannot shut out every other choice for an hour.
        expect(snoozeChoiceStamp(now + 60 * 60 * 1000, now)).toBe(now + CHOICE_AHEAD_ALLOWANCE_MS);
        expect(snoozeChoiceStamp(undefined, now)).toBe(now);
    });
});
