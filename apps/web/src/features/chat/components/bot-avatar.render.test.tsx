/**
 * BotAvatar where a 2D canvas can draw: the engine is mounted on the host, state changes go through `update`,
 * and reduced motion swaps the live avatar for a still image. The canvas probe is cached per module, so the
 * canvas is stubbed before the first render; the no-canvas case lives in bot-avatar.still.render.test.tsx.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BotAvatar } from "./bot-avatar";

const engine = vi.hoisted(() => {
    const update = vi.fn();
    const destroy = vi.fn();

    return {
        destroy,
        mountAvatar: vi.fn((_host: HTMLElement, _options: { label?: string }) => {
            return { destroy, update };
        }),
        reducedMotion: { value: false },
        update,
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

describe("BotAvatar with a canvas", () => {
    beforeEach(() => {
        engine.reducedMotion.value = false;
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

    it("passes a state change to the mounted avatar", () => {
        const { rerender } = render(<BotAvatar state="idle" />);

        rerender(<BotAvatar state="working" />);

        expect(engine.update).toHaveBeenLastCalledWith({ state: "working" });
    });

    it("replaces the live avatar with a still image when reduced motion turns on", () => {
        const { rerender } = render(<BotAvatar />);

        expect(screen.queryByRole("presentation")).toBeNull();

        engine.reducedMotion.value = true;
        rerender(<BotAvatar />);

        expect(screen.getByRole("presentation").getAttribute("alt")).toBe("");
        expect(engine.destroy).toHaveBeenCalledTimes(1);
    });
});
