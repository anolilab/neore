import { describe, expect, it } from "vitest";

import { contentMatchesType } from "./content-sniff";

const bytes = (...values: (number | string)[]): Uint8Array =>
    new Uint8Array(values.flatMap((value) => (typeof value === "string" ? [...value].map((character) => character.codePointAt(0) ?? 0) : [value])));

describe(contentMatchesType, () => {
    it.each([
        ["application/pdf", bytes("%PDF-1.7\n")],
        ["image/png", bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0)],
        ["image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0)],
        ["image/gif", bytes("GIF89a")],
        ["image/webp", bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 ")],
        ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes("PK", 3, 4, 20)],
        ["application/msword", bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)],
        ["text/plain", bytes("hello world")],
        ["text/plain", bytes(0xff, 0xfe, "h", 0, "i", 0)],
        ["application/json; charset=utf-8", bytes('{"a":1}')],
        // No rule for the type: passes.
        ["application/x-unknown", bytes(0, 1, 2)],
    ])("accepts %s that starts like one", (type, head) => {
        expect(contentMatchesType(head, type)).toBe(true);
    });

    it.each([
        ["application/pdf", bytes("<html><script>")],
        ["image/png", bytes("%PDF-1.7")],
        ["image/jpeg", bytes("GIF89a")],
        ["image/webp", bytes("RIFF", 0, 0, 0, 0, "AVI ")],
        ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes("%PDF")],
        ["text/plain", bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0)],
        ["image/svg+xml", bytes("<svg", 0)],
        ["application/pdf", bytes()],
    ])("refuses %s whose bytes are something else", (type, head) => {
        expect(contentMatchesType(head, type)).toBe(false);
    });
});
