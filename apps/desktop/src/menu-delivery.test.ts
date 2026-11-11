import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MenuCommand } from "./app-menu.js";
import { createMenuDelivery, MENU_READY_GRACE_MS } from "./menu-delivery.js";

interface Win {
    onSite: boolean;
}

const setup = () => {
    const sent: [Win, MenuCommand][] = [];
    const fellBack: [Win, MenuCommand][] = [];
    const delivery = createMenuDelivery<Win>({
        fallback: (win, command) => {
            fellBack.push([win, command]);
        },
        isShowingSite: (win) => win.onSite,
        send: (win, command) => {
            sent.push([win, command]);
        },
    });

    return { delivery, fellBack, sent };
};

describe(createMenuDelivery, () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("holds commands for a loading page, one of each in the order last asked for, and sends them when it listens", () => {
        const { delivery, sent } = setup();
        const win = { onSite: true };

        delivery.deliver(win, "new-chat");
        delivery.deliver(win, "settings");
        delivery.deliver(win, "new-chat");
        expect(sent).toStrictEqual([]);

        delivery.ready(win);
        delivery.deliver(win, "settings");
        expect(sent).toStrictEqual([
            [win, "settings"],
            [win, "new-chat"],
            [win, "settings"],
        ]);
    });

    it("starts over on each new document: the next page has to listen again", () => {
        const { delivery, sent } = setup();
        const win = { onSite: true };

        delivery.ready(win);
        delivery.navigated(win, true);
        delivery.deliver(win, "new-chat");
        expect(sent).toStrictEqual([]);

        delivery.ready(win);
        expect(sent).toStrictEqual([[win, "new-chat"]]);
    });

    it("falls back for a page that has not listened within the grace period after its load", () => {
        const { delivery, fellBack, sent } = setup();
        const win = { onSite: true };

        delivery.navigated(win, true);
        delivery.deliver(win, "new-chat");
        delivery.loaded(win);
        vi.advanceTimersByTime(MENU_READY_GRACE_MS - 1);
        expect(fellBack).toStrictEqual([]);

        vi.advanceTimersByTime(1);
        delivery.deliver(win, "settings");
        expect(fellBack).toStrictEqual([
            [win, "new-chat"],
            [win, "settings"],
        ]);
        expect(sent).toStrictEqual([]);
    });

    it("does not fall back once the page listens within the grace period", () => {
        const { delivery, fellBack } = setup();
        const win = { onSite: true };

        delivery.loaded(win);
        delivery.ready(win);
        vi.advanceTimersByTime(MENU_READY_GRACE_MS * 2);

        expect(fellBack).toStrictEqual([]);
    });

    it("queues nothing for a document that is not the site, and drops what was held when the window turns to one", () => {
        const { delivery, fellBack, sent } = setup();
        const win = { onSite: true };

        delivery.deliver(win, "new-chat");
        win.onSite = false;
        delivery.navigated(win, false);
        delivery.deliver(win, "settings");
        delivery.loaded(win);
        vi.advanceTimersByTime(MENU_READY_GRACE_MS);

        win.onSite = true;
        delivery.navigated(win, true);
        delivery.ready(win);

        expect(sent).toStrictEqual([]);
        expect(fellBack).toStrictEqual([]);
    });

    it("forgets a closed window, its queue and its pending fallback", () => {
        const { delivery, fellBack, sent } = setup();
        const win = { onSite: true };

        delivery.deliver(win, "new-chat");
        delivery.loaded(win);
        delivery.forget(win);
        vi.advanceTimersByTime(MENU_READY_GRACE_MS);
        delivery.ready(win);

        expect(fellBack).toStrictEqual([]);
        expect(sent).toStrictEqual([]);
    });
});
