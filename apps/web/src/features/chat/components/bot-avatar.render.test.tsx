/**
 * BotAvatar where a 2D canvas can draw: the engine is mounted on the host, state changes go through `update`,
 * reduced motion swaps the live avatar for a still image, and a label out of view is still. The canvas probe is
 * cached per module, so the canvas is stubbed before the first render; the no-canvas case lives in
 * bot-avatar.still.render.test.tsx.
 */

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BotAvatar, botColorFor } from "./bot-avatar";

const engine = vi.hoisted(() => {
    const update = vi.fn();
    const destroy = vi.fn();

    return {
        destroy,
        mountAvatar: vi.fn((_host: HTMLElement, _options: { color?: string; label?: string }) => {
            return { destroy, update };
        }),
        reducedMotion: { value: false },
        update,
    };
});

const observer = vi.hoisted(() => {
    return {
        disconnect: vi.fn(),
        observe: vi.fn(),
        report: undefined as ((entries: { isIntersecting: boolean }[]) => void) | undefined,
    };
});

vi.mock("open-bot-avatar/dom", () => {
    return { mountAvatar: engine.mountAvatar };
});

vi.mock("motion/react", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();

    return { ...actual, useReducedMotion: () => engine.reducedMotion.value };
});

vi.stubGlobal("Path2D", vi.fn());
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);

class StubIntersectionObserver {
    observe = observer.observe;

    disconnect = observer.disconnect;

    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        observer.report = callback;
    }
}

describe("BotAvatar with a canvas", () => {
    beforeEach(() => {
        engine.reducedMotion.value = false;
        // Without an observer every label counts as in view, so the live avatar mounts at once.
        vi.stubGlobal("IntersectionObserver", undefined);
        vi.clearAllMocks();
    });

    it("mounts the animated body on its host as a decorative element, and destroys it on unmount", () => {
        const { unmount } = render(<BotAvatar />);

        expect(engine.mountAvatar).toHaveBeenCalledTimes(1);
        const [call] = engine.mountAvatar.mock.calls;

        expect(call?.[0].isConnected).toBe(true);
        expect(call?.[1].label).toBe("");

        unmount();

        expect(engine.destroy).toHaveBeenCalledTimes(1);
    });

    it("mounts the body in the speaker's colour", () => {
        render(<BotAvatar name="Ada" />);

        const [call] = engine.mountAvatar.mock.calls;

        expect(call?.[1].color).toBe(botColorFor("Ada"));
    });

    it("passes a state change to the mounted avatar", () => {
        const { rerender } = render(<BotAvatar state="idle" />);

        rerender(<BotAvatar state="working" />);

        expect(engine.update).toHaveBeenLastCalledWith(expect.objectContaining({ state: "working" }));
    });

    it("replaces the live avatar with a still image when reduced motion turns on", () => {
        const { rerender } = render(<BotAvatar />);

        expect(screen.queryByRole("presentation")).toBeNull();

        engine.reducedMotion.value = true;
        rerender(<BotAvatar />);

        expect(screen.getByRole("presentation").getAttribute("alt")).toBe("");
        expect(engine.destroy).toHaveBeenCalledTimes(1);
    });

    it("runs the live avatar only while the label is in view", () => {
        vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);

        render(<BotAvatar />);

        expect(observer.observe).toHaveBeenCalledTimes(1);
        expect(engine.mountAvatar).not.toHaveBeenCalled();
        expect(screen.getByRole("presentation")).not.toBeNull();

        act(() => {
            observer.report?.([{ isIntersecting: true }]);
        });

        expect(engine.mountAvatar).toHaveBeenCalledTimes(1);

        act(() => {
            observer.report?.([{ isIntersecting: false }]);
        });

        expect(engine.destroy).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("presentation")).not.toBeNull();
    });
});

describe("botColorFor", () => {
    it("gives one name one colour", () => {
        expect(botColorFor("Ada")).toBe(botColorFor("Ada"));
    });

    it("spreads speakers over more than one colour", () => {
        const names = ["Ada", "Grace", "Linus", "Ken", "Dennis", "Barbara", "Margaret", "Alan"];

        expect(new Set(names.map((name) => botColorFor(name))).size).toBeGreaterThan(1);
    });

    it("uses the brand lime for a speaker with no name", () => {
        expect(botColorFor(undefined)).toBe("#caff00");
    });
});
