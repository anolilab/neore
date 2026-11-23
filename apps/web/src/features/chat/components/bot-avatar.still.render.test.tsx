/**
 * BotAvatar where no 2D canvas can draw: it renders a decorative still image of the current state and mounts
 * nothing. Kept apart from bot-avatar.render.test.tsx because the canvas probe is cached per module.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BotAvatar } from "./bot-avatar";

const SVG_SOURCE = /^data:image\/svg\+xml/;

const engine = vi.hoisted(() => {
    return { mountAvatar: vi.fn() };
});

vi.mock("open-bot-avatar/dom", () => {
    return { mountAvatar: engine.mountAvatar };
});

vi.stubGlobal("Path2D", undefined);
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

describe("BotAvatar without a canvas", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("renders a decorative still image and mounts no live avatar", () => {
        render(<BotAvatar />);

        const image = screen.getByRole("presentation");

        expect(image.getAttribute("alt")).toBe("");
        expect(image.getAttribute("src")).toMatch(SVG_SOURCE);
        expect(engine.mountAvatar).not.toHaveBeenCalled();
    });

    it("draws a different still for each state", () => {
        const { rerender } = render(<BotAvatar state="idle" />);
        const idle = screen.getByRole("presentation").getAttribute("src");

        rerender(<BotAvatar state="working" />);

        expect(screen.getByRole("presentation").getAttribute("src")).not.toBe(idle);
    });
});
