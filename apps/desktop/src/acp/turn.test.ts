import { describe, expect, it } from "vitest";

import { Turn } from "./turn";

const SECRET = "sk-secret-value-123";
const mask = (text: string): string => text.split(SECRET).join("***");

describe("a turn's text", () => {
    it("is cut at the limit and says so", () => {
        const turn = new Turn("hi");

        turn.append("text", "a".repeat(300_000));

        expect(turn.toState().text).toHaveLength(256_000);
        expect(turn.toState().truncated).toBe(true);
    });

    it("masks a value that straddles the cut instead of keeping its first half", () => {
        const turn = new Turn("hi", mask);

        turn.append("text", "a".repeat(255_990));
        turn.append("text", `${SECRET} and more`);

        const { text } = turn.toState();

        expect(text).not.toContain("sk-secret");
        expect(text).toContain("***");
    });
});
