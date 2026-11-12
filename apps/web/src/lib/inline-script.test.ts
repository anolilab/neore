import { describe, expect, it } from "vitest";

import { toScriptLiteral } from "./inline-script";

const SCRIPT_UNSAFE = /[<>/\u{2028}\u{2029}]/u;

describe(toScriptLiteral, () => {
    const hostile = "</script><script>alert(1)</script><!--\u{2028}\u{2029}";

    it("leaves nothing that can end the script element or break a line", () => {
        const literal = toScriptLiteral({ list: [hostile], value: hostile });

        expect(literal).not.toMatch(SCRIPT_UNSAFE);
    });

    it("still evaluates to the original value", () => {
        const value = { list: [hostile, 1, true, null], value: hostile };

        // eslint-disable-next-line sonarjs/code-eval -- evaluates the literal as an inline script would
        expect(new Function(`return ${toScriptLiteral(value)};`)()).toStrictEqual(value);
    });
});
