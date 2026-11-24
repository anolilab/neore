import { describe, expect, it } from "vitest";

import { chatOpenPlaceFor, DEFAULT_CHAT_OPEN_PLACE, readChatOpenPlace } from "./chat-open-place";

const PLAIN = { button: 0, ctrlKey: false, metaKey: false };
const CTRL = { ...PLAIN, ctrlKey: true };
const META = { ...PLAIN, metaKey: true };
const MIDDLE = { button: 1, ctrlKey: false, metaKey: false };

describe("readChatOpenPlace", () => {
    it("defaults to the side panel, and reads a saved main view as the main view", () => {
        expect(DEFAULT_CHAT_OPEN_PLACE).toBe("side");
        expect(readChatOpenPlace(undefined)).toBe("side");
        expect(readChatOpenPlace("")).toBe("side");
        expect(readChatOpenPlace("unknown")).toBe("side");
        expect(readChatOpenPlace("side")).toBe("side");
        expect(readChatOpenPlace("main")).toBe("main");
    });
});

describe("chatOpenPlaceFor", () => {
    it("opens the chosen place on a plain click", () => {
        expect(chatOpenPlaceFor("side", PLAIN, true)).toBe("side");
        expect(chatOpenPlaceFor("main", PLAIN, true)).toBe("main");
    });

    it("takes the other place with Ctrl, Cmd or the middle button", () => {
        expect(chatOpenPlaceFor("side", CTRL, true)).toBe("main");
        expect(chatOpenPlaceFor("side", META, true)).toBe("main");
        expect(chatOpenPlaceFor("side", MIDDLE, true)).toBe("main");
        expect(chatOpenPlaceFor("main", CTRL, true)).toBe("side");
        expect(chatOpenPlaceFor("main", META, true)).toBe("side");
        expect(chatOpenPlaceFor("main", MIDDLE, true)).toBe("side");
    });

    it("opens the main view for every click while the split view is off, since there is no side panel", () => {
        expect(chatOpenPlaceFor("side", PLAIN, false)).toBe("main");
        expect(chatOpenPlaceFor("side", CTRL, false)).toBe("main");
        expect(chatOpenPlaceFor("main", MIDDLE, false)).toBe("main");
    });

    it("leaves other mouse buttons to the browser's own menu, so they keep the chosen place", () => {
        expect(chatOpenPlaceFor("side", { ...PLAIN, button: 2 }, true)).toBe("side");
    });
});
