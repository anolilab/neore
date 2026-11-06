import { describe, expect, it } from "vitest";

import { insertCommand, matchingCommands, slashAtCursor } from "./host-slash";

describe("slashAtCursor", () => {
    it("finds a slash that starts the text, with the query typed after it", () => {
        expect(slashAtCursor("/com", 4)).toEqual({ end: 4, query: "com", start: 0 });
        expect(slashAtCursor("/", 1)).toEqual({ end: 1, query: "", start: 0 });
    });

    it("finds a slash after a space, and only the text before the cursor counts", () => {
        expect(slashAtCursor("fix this /re", 12)).toEqual({ end: 12, query: "re", start: 9 });
        expect(slashAtCursor("/review the code", 3)).toEqual({ end: 7, query: "re", start: 0 });
    });

    it("does not treat a slash inside a word, or a query with a space in it, as a menu", () => {
        expect(slashAtCursor("a/b", 3)).toBeNull();
        expect(slashAtCursor("/review the", 11)).toBeNull();
        expect(slashAtCursor("plain text", 10)).toBeNull();
    });
});

describe("matchingCommands", () => {
    it("shows a name the agent lists twice once", () => {
        expect(matchingCommands([{ name: "review" }, { name: "review", description: "user" }], "re")).toEqual([{ name: "review" }]);
    });

    it("keeps two names that differ only by case, since each inserts different text", () => {
        expect(matchingCommands([{ name: "Review" }, { name: "review" }], "re").map((command) => command.name)).toEqual(["Review", "review"]);
    });

    const commands = [{ name: "review", description: "Review the change" }, { name: "Refactor", hint: "file" }, { name: "test" }];

    it("keeps the commands whose name starts with the query, case-insensitively, in the agent's order", () => {
        expect(matchingCommands(commands, "re").map((command) => command.name)).toEqual(["review", "Refactor"]);
        expect(matchingCommands(commands, "RE").map((command) => command.name)).toEqual(["review", "Refactor"]);
    });

    it("lists every command for an empty query, and none for a name that is not there", () => {
        expect(matchingCommands(commands, "")).toHaveLength(3);
        expect(matchingCommands(commands, "zzz")).toEqual([]);
    });
});

describe("insertCommand", () => {
    it("replaces the whole word the cursor is in, not only the part before the cursor", () => {
        const text = "/review file";
        const context = slashAtCursor(text, 3);

        expect(context).not.toBeNull();
        expect(insertCommand(text, context!, { name: "review" })).toEqual({ cursor: 8, text: "/review file" });
    });

    it("replaces the typed slash and query with the command and a space, and puts the cursor after it", () => {
        const context = slashAtCursor("please /re", 10);

        expect(context).not.toBeNull();
        expect(insertCommand("please /re", context!, { name: "review" })).toEqual({ cursor: 15, text: "please /review " });
    });

    it("keeps the text after the cursor", () => {
        const text = "/re and more";
        const context = slashAtCursor(text, 3);

        expect(insertCommand(text, context!, { name: "review" })).toEqual({ cursor: 8, text: "/review and more" });
    });

    it("puts a space before a newline or tab that follows the word, and keeps the caret on the command's line", () => {
        const text = "/re\nnext";
        const next = insertCommand(text, slashAtCursor(text, 3)!, { name: "review" });

        expect(next).toEqual({ cursor: 8, text: "/review \nnext" });
        expect(next.text.slice(next.cursor)).toBe("\nnext");
    });

    it("leaves the caret past an existing space, so the menu closes on the picked command", () => {
        const text = "/re and more";
        const next = insertCommand(text, slashAtCursor(text, 3)!, { name: "review" });

        expect(slashAtCursor(next.text, next.cursor)).toBeNull();
    });
});
