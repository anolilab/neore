import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GhostEligibility } from "./ghost-completion-controller";
import {
    createGhostController,
    GHOST_ANNOUNCE_INTERVAL_MS,
    GHOST_DEBOUNCE_MS,
    GHOST_MAX_CONTEXT_CHARS,
    ghostContext,
    isGhostEligible,
    normalizeGhost,
    shouldAnnounceGhost,
} from "./ghost-completion-controller";

const DRAFT = "Can you help me write";

const state = (overrides: Partial<GhostEligibility> = {}): GhostEligibility => {
    return { caretAtEnd: true, disabled: false, focused: true, isStreaming: false, popupOpen: false, text: DRAFT, ...overrides };
};

describe(isGhostEligible, () => {
    it("accepts a long enough draft with the caret at its end", () => {
        expect(isGhostEligible(state())).toBe(true);
    });

    it.each([
        ["too short", { text: "Hi there" }],
        ["caret not at the end", { caretAtEnd: false }],
        ["streaming", { isStreaming: true }],
        ["disabled", { disabled: true }],
        ["popup open", { popupOpen: true }],
        ["not focused", { focused: false }],
        ["slash command", { text: "/model gemini flash please" }],
        ["unfinished mention", { text: "Please summarise @report" }],
        ["unfinished variable", { text: "Write an email to {{recip" }],
    ])("refuses when %s", (_label, overrides) => {
        expect(isGhostEligible(state(overrides))).toBe(false);
    });

    it("allows a finished variable and a mid-sentence slash", () => {
        expect(isGhostEligible(state({ text: "Write an email to {{name}} about" }))).toBe(true);
        expect(isGhostEligible(state({ text: "Compare these and/or those" }))).toBe(true);
    });
});

describe(ghostContext, () => {
    it("sends only the tail of a long draft", () => {
        const long = `${"x".repeat(GHOST_MAX_CONTEXT_CHARS)}tail`;

        expect(ghostContext(long)).toHaveLength(GHOST_MAX_CONTEXT_CHARS);
        expect(ghostContext(long).endsWith("tail")).toBe(true);
    });
});

describe(normalizeGhost, () => {
    it("keeps one line and drops a doubled space", () => {
        expect(normalizeGhost("Hello ", " world\nmore")).toBe("world");
        expect(normalizeGhost("Hello", " world")).toBe(" world");
    });

    it("returns null for nothing usable", () => {
        expect(normalizeGhost(DRAFT, "")).toBeNull();
        expect(normalizeGhost(DRAFT, null)).toBeNull();
        expect(normalizeGhost(DRAFT, " ".repeat(3))).toBeNull();
    });
});

describe(shouldAnnounceGhost, () => {
    it("announces the first time and then at most once per interval", () => {
        expect(shouldAnnounceGhost(null, 0)).toBe(true);
        expect(shouldAnnounceGhost(1000, 1000 + GHOST_ANNOUNCE_INTERVAL_MS - 1)).toBe(false);
        expect(shouldAnnounceGhost(1000, 1000 + GHOST_ANNOUNCE_INTERVAL_MS)).toBe(true);
    });
});

describe(createGhostController, () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const setup = (request: (text: string, signal: AbortSignal) => Promise<string | null>) => {
        let text = DRAFT;
        const suggestions: (string | null)[] = [];
        const controller = createGhostController({
            getText: () => text,
            onSuggestion: (suggestion) => {
                suggestions.push(suggestion);
            },
            request,
        });

        return {
            controller,
            setText: (next: string) => {
                text = next;
            },
            suggestions,
        };
    };

    it("requests once after the pause and shows the answer", async () => {
        const request = vi.fn(async () => " a cover letter");
        const { controller, suggestions } = setup(request);

        controller.update(state());
        await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS - 1);

        expect(request).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(DRAFT, expect.any(AbortSignal));
        expect(suggestions.at(-1)).toBe(" a cover letter");
    });

    it("debounces: typing restarts the timer", async () => {
        const request = vi.fn(async () => " x");
        const { controller, setText } = setup(request);

        controller.update(state());
        await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS / 2);
        setText(`${DRAFT} a`);
        controller.update(state({ text: `${DRAFT} a` }));
        await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS / 2);

        expect(request).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS / 2);

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(`${DRAFT} a`, expect.any(AbortSignal));
    });

    it("drops a stale answer and aborts its request when the user types on", async () => {
        let settle: (value: string) => void = () => {};
        let seenSignal: AbortSignal | undefined;
        const request = vi.fn(
            async (_text: string, signal: AbortSignal) =>
                await new Promise<string>((resolve) => {
                    seenSignal = signal;
                    settle = resolve;
                }),
        );
        const { controller, setText, suggestions } = setup(request);

        controller.update(state());
        await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS);

        setText(`${DRAFT} a`);
        controller.update(state({ text: `${DRAFT} a` }));
        settle(" stale");
        await vi.advanceTimersByTimeAsync(0);

        expect(seenSignal?.aborted).toBe(true);
        expect(suggestions).not.toContain(" stale");
        expect(suggestions.at(-1)).toBeNull();
    });

    it("clears the ghost on every update and requests nothing when ineligible", async () => {
        const request = vi.fn(async () => " x");
        const { controller, suggestions } = setup(request);

        controller.update(state({ isStreaming: true }));
        await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS * 2);

        expect(request).not.toHaveBeenCalled();
        expect(suggestions).toStrictEqual([null]);
    });

    it("treats a failed request as no suggestion", async () => {
        const request = vi.fn(async () => {
            throw new Error("rate limited");
        });
        const { controller, suggestions } = setup(request);

        controller.update(state());
        await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS);

        expect(suggestions.at(-1)).toBeNull();
    });

    it("does nothing after dispose", async () => {
        const request = vi.fn(async () => " x");
        const { controller } = setup(request);

        controller.update(state());
        controller.dispose();
        await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS * 2);

        expect(request).not.toHaveBeenCalled();
    });
});
