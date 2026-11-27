import { describe, expect, it } from "vitest";

import { findEmojiShortcodeQuery, readEmojiShortcodeToken } from "./trigger";

describe("findEmojiShortcodeQuery", () => {
    it.each([
        [":dog", "dog", 0],
        ["hi :dog", "dog", 3],
        ["hi\n:do", "do", 3],
        ["hi\t:spee", "spee", 3],
        [":Dog", "dog", 0],
        [":thumbs_up", "thumbs_up", 0],
        [":speed-boat", "speed-boat", 0],
        [":123", "123", 0],
        [":+1", "+1", 0],
        [":-1", "-1", 0],
        ["hi :+1", "+1", 3],
    ])("opens for %j with query %j", (text, query, startOffset) => {
        expect(findEmojiShortcodeQuery(text)).toEqual({ query, startOffset });
    });

    it.each([
        ["empty text", ""],
        ["a lone colon", ":"],
        ["one letter", ":d"],
        ["a sign alone", ":+"],
        ["one digit with another sign", ":++1"],
        ["one digit and a sign reversed", ":1+"],
        ["only separators", ":_-"],
        ["a space after the colon", ": dog"],
        ["a space ending the query", ":dog "],
        ["a space inside the query", ":dog and"],
        ["a closing colon", ":dog:"],
        ["a time", "12:40"],
        ["a partial time", "12:4"],
        ["a URL scheme", "https://example.com"],
        ["a URL port or path", "see https://a.io/b:dog"],
        ["the colons of code", "::dog"],
        ["a colon inside a word", "word:dog"],
        ["a colon after punctuation", "(:dog"],
        ["a colon after a non-whitespace leaf", "a\u{FFFC}:dog"],
        ["a non-ASCII query", ":café"],
    ])("stays closed for %s (%j)", (_label, text) => {
        expect(findEmojiShortcodeQuery(text)).toBeNull();
    });

    it("reads the query after the last colon only", () => {
        expect(findEmojiShortcodeQuery(":dog :spee")).toEqual({ query: "spee", startOffset: 5 });
    });

    it("reports a shorter shortcode that does not open the list, so a dismissal can hold through it", () => {
        expect(readEmojiShortcodeToken("hi :d")).toEqual({ query: "d", startOffset: 3 });
        expect(findEmojiShortcodeQuery("hi :d")).toBeNull();
    });
});
