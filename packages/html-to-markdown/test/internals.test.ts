import { describe, expect, it } from "vitest";

import { edgeWhitespace } from "../src/node";

function ews(leadingAscii: string, leadingNonAscii: string, trailingNonAscii: string, trailingAscii: string) {
    return {
        leading: leadingAscii + leadingNonAscii,
        leadingAscii,
        leadingNonAscii,
        trailing: trailingNonAscii + trailingAscii,
        trailingAscii,
        trailingNonAscii,
    };
}

const WS = "\r\n \t";

describe("edge whitespace detection", () => {
    const cases: [string, ReturnType<typeof ews>][] = [
        [`${WS}HELLO WORLD${WS}`, ews(WS, "", "", WS)],
        [`${WS}H${WS}`, ews(WS, "", "", WS)],
        [`${WS}\u{A0}${WS}HELLO${WS}WORLD${WS}\u{A0}${WS}`, ews(WS, `\u{A0}${WS}`, `${WS}\u{A0}`, WS)],
        [`\u{A0}${WS}HELLO${WS}WORLD${WS}\u{A0}`, ews("", `\u{A0}${WS}`, `${WS}\u{A0}`, "")],
        [`\u{A0}${WS}\u{A0}`, ews("", `\u{A0}${WS}\u{A0}`, "", "")],
        [`${WS}\u{A0}${WS}`, ews(WS, `\u{A0}${WS}`, "", "")],
        [`${WS}\u{A0}`, ews(WS, "\u{A0}", "", "")],
        ["HELLO WORLD", ews("", "", "", "")],
        ["", ews("", "", "", "")],
        // performance check: a long run of inner spaces must stay linear
        [`TEST${" ".repeat(32_767)}END`, ews("", "", "", "")],
    ];

    for (const [input, expected] of cases) {
        it(`detects edges of ${JSON.stringify(input.slice(0, 24))}`, () => {
            expect(edgeWhitespace(input)).toEqual(expected);
        });
    }
});
