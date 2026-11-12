import { afterEach, describe, expect, it } from "vitest";

import { clearLastAccountHint, hasLastAccountHint, writeLastAccountHint } from "./last-account-hint";

describe("the signed-in hint", () => {
    afterEach(() => {
        clearLastAccountHint();
        localStorage.clear();
    });

    it("keeps a fixed marker and no account id", () => {
        writeLastAccountHint();

        expect(hasLastAccountHint()).toBe(true);
        expect(Object.keys(localStorage)).toEqual(["neore-signed-in-hint"]);
        expect(localStorage.getItem("neore-signed-in-hint")).toBe("1");
    });
});
