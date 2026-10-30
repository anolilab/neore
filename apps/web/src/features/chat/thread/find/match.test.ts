import { describe, expect, it } from "vitest";

import type { FindableMessage } from "./match";
import { clampIndex, findMatches, MAX_FIND_PAGES, messageTexts, nextFindPaging, occurrenceOffsets, stepIndex, visibleText } from "./match";

const message = (id: string, role: string, ...texts: string[]): FindableMessage => {
    return {
        id,
        parts: texts.map((text) => {
            return { text, type: "text" };
        }),
        role,
    };
};

describe("occurrenceOffsets", () => {
    it("finds case-insensitive, non-overlapping occurrences", () => {
        expect(occurrenceOffsets("Foo foo FOO", "foo")).toEqual([0, 4, 8]);
        expect(occurrenceOffsets("aaaa", "aa")).toEqual([0, 2]);
    });

    it("keeps offsets valid where lowercasing changes the length", () => {
        const text = "İİ cat";

        expect(occurrenceOffsets(text, "cat")).toEqual([3]);
        expect(text.slice(3, 6)).toBe("cat");
    });

    it("treats regex characters in the query literally", () => {
        expect(occurrenceOffsets("a.b a+b (x) [y] a|b", ".")).toEqual([1]);
        expect(occurrenceOffsets("a.b a+b (x) [y] a|b", "a+b")).toEqual([4]);
        expect(occurrenceOffsets("f(x) [y] $1 ^", "(x) [y] $1 ^")).toEqual([1]);
    });

    it("finds nothing for an empty or blank query", () => {
        expect(occurrenceOffsets("anything", "")).toEqual([]);
        expect(occurrenceOffsets("a b", " ".repeat(3))).toEqual([]);
    });
});

describe("messageTexts", () => {
    it("lists the text parts, one entry each, and skips reasoning and tools", () => {
        const parts = [{ text: "one", type: "text" }, { text: "hidden", type: "reasoning" }, { type: "tool-search" }, { text: "two", type: "text" }];

        expect(messageTexts({ id: "m", parts, role: "assistant" })).toEqual(["one", "two"]);
    });
});

describe("visibleText", () => {
    it("drops markdown syntax and keeps what is rendered", () => {
        expect(visibleText("# Title\n**bold** and _it_ and `code`\n- item\n> quote")).toBe("Title\nbold and it and code\nitem\nquote");
        expect(visibleText("see [the docs](https://example.com/x) now")).toBe("see the docs now");
        expect(visibleText("```ts\nconst a = 1;\n```")).toBe("\nconst a = 1;\n");
    });

    it("leaves identifiers with underscores alone", () => {
        expect(visibleText("call snake_case_name here")).toBe("call snake_case_name here");
    });
});

describe("findMatches", () => {
    it("lists matches in thread order with their occurrence inside the message", () => {
        const messages = [message("a", "user", "Cat and cat"), message("b", "assistant", "no hit"), message("c", "assistant", "a CAT")];

        expect(findMatches(messages, "cat")).toEqual([
            { messageId: "a", occurrence: 0 },
            { messageId: "a", occurrence: 1 },
            { messageId: "c", occurrence: 0 },
        ]);
    });

    it("searches only user and assistant messages", () => {
        expect(findMatches([message("s", "system", "cat"), message("t", "tool", "cat")], "cat")).toEqual([]);
    });

    it("finds nothing for an empty query", () => {
        expect(findMatches([message("a", "user", "cat")], "")).toEqual([]);
    });

    it("counts only what is rendered: not markdown syntax, link targets, or a match across two parts", () => {
        const messages = [message("a", "assistant", "**bold** [docs](https://example.com)", "cat", "dog")];

        expect(findMatches(messages, "**")).toEqual([]);
        expect(findMatches(messages, "https")).toEqual([]);
        expect(findMatches(messages, "docs")).toHaveLength(1);
        expect(findMatches(messages, "cat\ndog")).toEqual([]);
        expect(findMatches(messages, "catdog")).toEqual([]);
    });

    it("skips the last reply while it is still streaming, because the list shows a placeholder for it", () => {
        const streaming = { ...message("b", "assistant", "cat"), status: "streaming" };

        expect(findMatches([message("a", "user", "cat"), streaming], "cat")).toEqual([{ messageId: "a", occurrence: 0 }]);
        expect(findMatches([streaming, message("c", "user", "cat")], "cat")).toHaveLength(2);
        expect(findMatches([message("a", "user", "cat"), { ...streaming, status: "success" }], "cat")).toHaveLength(2);
        expect(findMatches([message("a", "user", "cat"), { ...streaming, status: "pending" }], "cat")).toHaveLength(1);
    });

    it("keeps a failed last reply, which still shows its text", () => {
        expect(findMatches([message("a", "user", "cat"), { ...message("b", "assistant", "cat"), status: "failed" }], "cat")).toHaveLength(2);
    });
});

describe("stepIndex", () => {
    it("wraps in both directions", () => {
        expect(stepIndex(2, 3, 1)).toBe(0);
        expect(stepIndex(0, 3, -1)).toBe(2);
        expect(stepIndex(1, 3, 1)).toBe(2);
    });

    it("stays at 0 without matches", () => {
        expect(stepIndex(0, 0, 1)).toBe(0);
    });
});

describe("clampIndex", () => {
    it("keeps the index inside the list", () => {
        expect(clampIndex(5, 3)).toBe(2);
        expect(clampIndex(1, 3)).toBe(1);
        expect(clampIndex(4, 0)).toBe(0);
    });
});

describe("nextFindPaging", () => {
    it("stops after consecutive requests that added no message", () => {
        let paging = { lastCount: 10, pages: 0, stalls: 0 };
        const first = nextFindPaging(paging, 10);

        expect(first.stop).toBe(false);
        paging = first.paging;
        expect(nextFindPaging(paging, 10).stop).toBe(true);
    });

    it("keeps going while pages add messages, up to the page cap", () => {
        let paging = { lastCount: 0, pages: 0, stalls: 0 };
        let count = 0;

        for (let page = 0; page < MAX_FIND_PAGES; page += 1) {
            count += 50;

            const step = nextFindPaging(paging, count);

            expect(step.stop).toBe(false);
            paging = step.paging;
        }

        expect(nextFindPaging(paging, count + 50).stop).toBe(true);
    });
});
