import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scrollToMessage } from "./scroll-to-message";

const stubReducedMotion = (reduce: boolean): void => {
    vi.stubGlobal("matchMedia", (query: string) => {
        return { matches: reduce && query === "(prefers-reduced-motion: reduce)", media: query };
    });
};

describe(scrollToMessage, () => {
    beforeEach(() => {
        stubReducedMotion(false);
    });

    afterEach(() => {
        document.body.replaceChildren();
        vi.unstubAllGlobals();
    });

    it("scrolls the reply with that id into view and answers true", () => {
        const reply = document.createElement("div");
        const scrollIntoView = vi.fn();

        reply.dataset.messageId = "msg-2";
        reply.scrollIntoView = scrollIntoView;
        document.body.appendChild(reply);

        expect(scrollToMessage("msg-2")).toBe(true);
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    });

    it("scrolls instantly when the user prefers reduced motion", () => {
        stubReducedMotion(true);

        const reply = document.createElement("div");
        const scrollIntoView = vi.fn();

        reply.dataset.messageId = "msg-3";
        reply.scrollIntoView = scrollIntoView;
        document.body.appendChild(reply);

        expect(scrollToMessage("msg-3")).toBe(true);
        expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "center" });
    });

    it("moves focus to the reply without scrolling a second time", () => {
        const reply = document.createElement("div");

        reply.dataset.messageId = "msg-4";
        reply.scrollIntoView = vi.fn();
        document.body.appendChild(reply);

        const focus = vi.spyOn(reply, "focus");

        expect(scrollToMessage("msg-4")).toBe(true);
        expect(reply.tabIndex).toBe(-1);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(document.activeElement).toBe(reply);
    });

    it("keeps a tabindex the reply already has", () => {
        const reply = document.createElement("div");

        reply.dataset.messageId = "msg-5";
        reply.tabIndex = 0;
        reply.scrollIntoView = vi.fn();
        document.body.appendChild(reply);

        scrollToMessage("msg-5");

        expect(reply.tabIndex).toBe(0);
    });

    it("answers false when that reply is not rendered", () => {
        const reply = document.createElement("div");

        reply.dataset.messageId = "msg-1";
        document.body.appendChild(reply);

        expect(scrollToMessage("msg-9")).toBe(false);
    });
});
