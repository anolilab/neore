import { afterEach, describe, expect, it, vi } from "vitest";

import { scrollToMessage } from "./scroll-to-message";

describe(scrollToMessage, () => {
    afterEach(() => {
        document.body.replaceChildren();
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

    it("answers false when that reply is not rendered", () => {
        const reply = document.createElement("div");

        reply.dataset.messageId = "msg-1";
        document.body.appendChild(reply);

        expect(scrollToMessage("msg-9")).toBe(false);
    });
});
