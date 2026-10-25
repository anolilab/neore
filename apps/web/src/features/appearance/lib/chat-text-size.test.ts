import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useLayoutState } from "@/features/layout/hooks/use-ui-state";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import { UI_STATE_STORAGE_KEY } from "./accent-boot-script";
import { applyChatTextSize, CHAT_TEXT_SIZE_ATTRIBUTE, CHAT_TEXT_SIZE_BOOT_SCRIPT, DEFAULT_CHAT_TEXT_SIZE, isChatTextSize } from "./chat-text-size";

const runBootScript = (): void => {
    // eslint-disable-next-line sonarjs/code-eval -- runs the inline script exactly as the browser would
    new Function(CHAT_TEXT_SIZE_BOOT_SCRIPT)();
};

const store = (layout: unknown): void => {
    localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify({ state: { layout }, version: 0 }));
};

const attribute = (): string | null => document.documentElement.getAttribute(CHAT_TEXT_SIZE_ATTRIBUTE);

describe("chat text size boot script", () => {
    afterEach(() => {
        localStorage.clear();
        document.documentElement.removeAttribute(CHAT_TEXT_SIZE_ATTRIBUTE);
    });

    it("is a fixed script whose literals match the storage key and attribute", () => {
        expect(CHAT_TEXT_SIZE_BOOT_SCRIPT).not.toContain("${");
        expect(CHAT_TEXT_SIZE_BOOT_SCRIPT).toContain(`localStorage.getItem(${JSON.stringify(UI_STATE_STORAGE_KEY)})`);
        expect(CHAT_TEXT_SIZE_BOOT_SCRIPT).toContain(`setAttribute(${JSON.stringify(CHAT_TEXT_SIZE_ATTRIBUTE)},z)`);
    });

    it("applies a stored small or large size before hydration", () => {
        store({ fontSize: "large" });
        runBootScript();
        expect(attribute()).toBe("large");

        store({ fontSize: "small" });
        runBootScript();
        expect(attribute()).toBe("small");
    });

    it("changes nothing for the default size, no storage, unknown values or corrupt storage", () => {
        store({ fontSize: "medium" });
        runBootScript();
        expect(attribute()).toBeNull();

        localStorage.clear();
        runBootScript();
        expect(attribute()).toBeNull();

        store({ fontSize: '"><script>alert(1)</script>' });
        runBootScript();
        expect(attribute()).toBeNull();

        localStorage.setItem(UI_STATE_STORAGE_KEY, "{not json");
        expect(runBootScript).not.toThrow();
        expect(attribute()).toBeNull();
    });
});

describe("applyChatTextSize", () => {
    afterEach(() => {
        document.documentElement.removeAttribute(CHAT_TEXT_SIZE_ATTRIBUTE);
    });

    it("sets the attribute for small and large and clears it for the default", () => {
        applyChatTextSize("small");
        expect(attribute()).toBe("small");

        applyChatTextSize("large");
        expect(attribute()).toBe("large");

        applyChatTextSize("medium");
        expect(attribute()).toBeNull();
    });

    it("ignores values that are not a size", () => {
        applyChatTextSize("large");
        applyChatTextSize("huge");
        expect(attribute()).toBeNull();
        expect(isChatTextSize("huge")).toBe(false);
    });
});

describe("persisted chat text size", () => {
    beforeEach(() => {
        localStorage.clear();
        useUIStateStore.getState().resetLayout();
    });

    it("defaults to medium, which is today's size", () => {
        expect(DEFAULT_CHAT_TEXT_SIZE).toBe("medium");
        expect(useUIStateStore.getState().layout.fontSize).toBe("medium");
    });

    it("writes the choice to the persisted store, where the boot script reads it", () => {
        useUIStateStore.getState().setLayoutState({ fontSize: "large" });

        const persisted = JSON.parse(localStorage.getItem(UI_STATE_STORAGE_KEY) ?? "null");

        expect(persisted.state.layout.fontSize).toBe("large");

        runBootScript();
        expect(attribute()).toBe("large");
        document.documentElement.removeAttribute(CHAT_TEXT_SIZE_ATTRIBUTE);
    });

    it("is what useLayoutState().setFontSize writes", () => {
        const { result } = renderHook(() => useLayoutState());

        expect(result.current.fontSize).toBe("medium");

        act(() => result.current.setFontSize("small"));

        expect(result.current.fontSize).toBe("small");
        expect(JSON.parse(localStorage.getItem(UI_STATE_STORAGE_KEY) ?? "null").state.layout.fontSize).toBe("small");
    });
});

const TOKEN_RULE = /:root\[data-chat-text-size\] \.message-text \{([^}]*)\}/;
const LIST_SCOPED_RULE = /data-chat-text-size\][^{]*\.message-list/;
const ROOT_TOKEN_RULE = /:root\[data-chat-text-size[^\]]*\]\s*\{[^}]*--text-/;

describe("chat text size styles", () => {
    const css = readFileSync(join(__dirname, "../../../styles.css"), "utf8");

    it("defines the scale for small and large only", () => {
        expect(css).toContain(':root[data-chat-text-size="small"] {\n    --chat-text-scale: 0.875;');
        expect(css).toContain(':root[data-chat-text-size="large"] {\n    --chat-text-scale: 1.125;');
    });

    it("scales the text tokens on the message content wrapper only, not on the root or the whole list", () => {
        const rule = css.match(TOKEN_RULE)?.[1] ?? "";

        for (const token of ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"]) {
            expect(rule).toMatch(new RegExp(String.raw`--text-${token}: calc\([\d.]+rem \* var\(--chat-text-scale\)\);`));
        }

        expect(css).not.toMatch(ROOT_TOKEN_RULE);
        expect(css).not.toMatch(LIST_SCOPED_RULE);
    });

    it("has no rule for the default size, so it changes nothing", () => {
        expect(css).not.toContain('data-chat-text-size="medium"');
    });
});
