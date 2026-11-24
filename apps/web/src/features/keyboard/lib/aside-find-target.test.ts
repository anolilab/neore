// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { hasAsideFindTarget } from "./aside-find-target";

describe("hasAsideFindTarget", () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it("is true only while focus is inside the side-question panel", () => {
        document.body.innerHTML = `
            <section data-aside-find-host="" tabindex="-1"><textarea id="inside"></textarea></section>
            <div><textarea id="outside"></textarea></div>
        `;

        document.querySelector<HTMLElement>("#inside")?.focus();
        expect(hasAsideFindTarget()).toBe(true);

        document.querySelector<HTMLElement>("#outside")?.focus();
        expect(hasAsideFindTarget()).toBe(false);
    });

    it("is true when focus lands on the panel section itself", () => {
        document.body.innerHTML = `<section data-aside-find-host="" tabindex="-1"><p>Answer</p></section>`;

        document.querySelector<HTMLElement>("section")?.focus();

        expect(hasAsideFindTarget()).toBe(true);
    });

    it("is false when nothing is focused", () => {
        document.body.innerHTML = `<section data-aside-find-host="" tabindex="-1"></section>`;

        expect(hasAsideFindTarget()).toBe(false);
    });
});
