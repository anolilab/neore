import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MenuCommand } from "./app-menu.js";
import { createMenuDelivery, MENU_READY_GRACE_MS } from "./menu-delivery.js";

interface Win {
    onSite: boolean;
}

const setup = () => {
    const sent: [Win, MenuCommand][] = [];
    const fellBack: [Win, MenuCommand][] = [];
    const offSite: [Win, MenuCommand][] = [];
    const delivery = createMenuDelivery<Win>({
        fallback: (win, command) => {
            fellBack.push([win, command]);
        },
        isShowingSite: (win) => win.onSite,
        offSite: (win, command) => {
            offSite.push([win, command]);
        },
        send: (win, command) => {
            sent.push([win, command]);
        },
    });

    return { delivery, fellBack, offSite, sent };
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
        const { delivery, fellBack, offSite, sent } = setup();
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
        expect(offSite).toStrictEqual([[win, "settings"]]);
    });

    it("hands a command for a committed off-site document over at once, and holds it again once a navigation starts", () => {
        const { delivery, fellBack, offSite, sent } = setup();
        const win = { onSite: false };

        delivery.navigated(win, false);
        delivery.deliver(win, "new-chat");
        expect(offSite).toStrictEqual([[win, "new-chat"]]);

        delivery.navigationStarted(win);
        delivery.deliver(win, "settings");
        win.onSite = true;
        delivery.navigated(win, true);
        delivery.ready(win);

        expect(offSite).toStrictEqual([[win, "new-chat"]]);
        expect(sent).toStrictEqual([[win, "settings"]]);
        expect(fellBack).toStrictEqual([]);
    });

    it("holds a command chosen while a navigation is under way and sends it to the new page once it listens", () => {
        const { delivery, fellBack, sent } = setup();
        const win = { onSite: true };

        delivery.ready(win);
        delivery.navigationStarted(win);
        delivery.deliver(win, "new-chat");
        // The departing page subscribing again (or late) is not the new page listening.
        delivery.ready(win);
        expect(sent).toStrictEqual([]);

        delivery.navigated(win, true);
        delivery.loaded(win);
        delivery.ready(win);
        vi.advanceTimersByTime(MENU_READY_GRACE_MS);

        expect(sent).toStrictEqual([[win, "new-chat"]]);
        expect(fellBack).toStrictEqual([]);
    });

    it("runs no grace period for the departing page while a navigation is under way", () => {
        const { delivery, fellBack, sent } = setup();
        const win = { onSite: true };

        delivery.loaded(win);
        delivery.navigationStarted(win);
        delivery.deliver(win, "new-chat");
        vi.advanceTimersByTime(MENU_READY_GRACE_MS * 2);

        expect(fellBack).toStrictEqual([]);
        expect(sent).toStrictEqual([]);
    });

    it("gives the page back what it was when a navigation never commits", () => {
        const { delivery, sent } = setup();
        const win = { onSite: true };

        delivery.ready(win);
        delivery.navigationStarted(win);
        delivery.deliver(win, "settings");
        expect(sent).toStrictEqual([]);

        delivery.navigationAbandoned(win);
        delivery.deliver(win, "new-chat");
        expect(sent).toStrictEqual([
            [win, "settings"],
            [win, "new-chat"],
        ]);
    });

    it("gives the page back what it was when loading stops with a navigation still uncommitted", () => {
        const { delivery, sent } = setup();
        const win = { onSite: true };

        delivery.ready(win);
        delivery.navigationStarted(win);
        delivery.deliver(win, "settings");
        expect(sent).toStrictEqual([]);

        delivery.loaded(win);
        delivery.deliver(win, "new-chat");
        expect(sent).toStrictEqual([
            [win, "settings"],
            [win, "new-chat"],
        ]);
    });

    it("gives the page back at once when the shell cancels a navigation, and counts its later failure only once", () => {
        const { delivery, sent } = setup();
        const win = { onSite: true };

        delivery.ready(win);
        delivery.navigationStarted(win);
        delivery.deliver(win, "settings");
        delivery.navigationCancelled(win);
        expect(sent).toStrictEqual([[win, "settings"]]);

        // A cancelled navigation that no longer counts gives nothing back twice, and the count never goes below zero.
        delivery.navigationCancelled(win);
        delivery.navigationStarted(win);
        delivery.navigationAbandoned(win);
        delivery.deliver(win, "new-chat");
        expect(sent).toStrictEqual([[win, "settings"]]);

        // A second navigation is pending while the first is cancelled: commands stay held until both are done.
        delivery.navigationStarted(win);
        delivery.navigationCancelled(win);
        delivery.navigationAbandoned(win);
        expect(sent).toStrictEqual([[win, "settings"]]);

        delivery.navigationAbandoned(win);
        expect(sent).toStrictEqual([
            [win, "settings"],
            [win, "new-chat"],
        ]);
    });

    it("runs the grace period for a page that was not listening when its navigation is settled at the stop", () => {
        const { delivery, fellBack } = setup();
        const win = { onSite: true };

        delivery.loaded(win);
        delivery.navigationStarted(win);
        delivery.deliver(win, "new-chat");
        delivery.loaded(win);
        vi.advanceTimersByTime(MENU_READY_GRACE_MS);

        expect(fellBack).toStrictEqual([[win, "new-chat"]]);
    });

    it("holds commands again once the page stops listening, and sends them when it listens again", () => {
        const { delivery, fellBack, sent } = setup();
        const win = { onSite: true };

        delivery.loaded(win);
        delivery.ready(win);
        delivery.unready(win);
        delivery.deliver(win, "new-chat");
        vi.advanceTimersByTime(MENU_READY_GRACE_MS - 1);
        delivery.ready(win);

        expect(sent).toStrictEqual([[win, "new-chat"]]);
        expect(fellBack).toStrictEqual([]);
    });

    it("falls back for a loaded page that stopped listening and does not listen again within the grace period", () => {
        const { delivery, fellBack, sent } = setup();
        const win = { onSite: true };

        delivery.loaded(win);
        delivery.ready(win);
        delivery.unready(win);
        delivery.deliver(win, "new-chat");
        vi.advanceTimersByTime(MENU_READY_GRACE_MS);

        expect(fellBack).toStrictEqual([[win, "new-chat"]]);
        expect(sent).toStrictEqual([]);
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
