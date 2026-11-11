"use client";

import { setStreamdownAppearance } from "@neore/ui/hooks/use-streamdown-appearance";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { authClient } from "@/lib/auth/client";
import { useCRPC } from "@/lib/lunora/crpc";
import { getNativeSystemAccentColor, hasNativeCapability, isNativeShell, onNativeSystemAccentColor } from "@/lib/native/bridge";

import { applyAccentAttribute, applyContrastAttribute, applyRootAttribute } from "../lib/accent-boot-script";
import { DEFAULT_ACCENT, isAccentId } from "../lib/accent-presets";
import { applyChatTextSize } from "../lib/chat-text-size";
import { CODE_HIGHLIGHT_THEMES, isCodeHighlightThemeId, isMermaidThemeId } from "../lib/code-themes";
import {
    DEFAULT_CONTRAST,
    DEFAULT_DENSITY,
    DEFAULT_MAIN_FONT,
    DENSITY_ATTRIBUTE,
    effectiveContrast,
    FONT_ATTRIBUTE,
    isContrastId,
    isDensityId,
    isMainFontId,
    PREFERS_MORE_CONTRAST_QUERY,
} from "../lib/display-preferences";
import {
    applySystemAccentTokens,
    cacheSystemAccentTokens,
    effectiveAccent,
    effectiveMainFont,
    SYSTEM_ACCENT,
    systemAccentTokens,
} from "../lib/native-appearance";

/**
 * Applies the Appearance settings app-wide; renders nothing.
 *
 * - The accent, density and font go on `<html>` as `data-accent`,
 *   `data-density` and `data-font` (the boot script already did so before first
 *   paint; this keeps them in step with later changes).
 * - In the desktop shell, an untouched accent and font become the OS accent
 *   (followed live) and the system face (`native-appearance.ts`).
 * - The chat text size goes on `<html data-chat-text-size>` the same way.
 * - The code / Mermaid themes are pushed to the Streamdown renderers.
 * - The account's stored choice (`userSettings`) is adopted when it arrives or
 *   changes, so it follows the user across devices. Deferred past first paint
 *   and skipped when signed out: localStorage already painted the right thing,
 *   and first paint's query budget is not spent on it.
 */
const AppearanceSync = () => {
    const { accentColor, capLongCodeBlocks, codeHighlightTheme, codeLineNumbers, contrast, density, explicit, mainFont, mermaidTheme } = useUIStateStore(
        (state) => state.appearance,
    );
    const accentExplicit = explicit?.accentColor === true;
    const fontExplicit = explicit?.mainFont === true;
    const setAppearance = useUIStateStore((state) => state.setAppearance);
    const chatTextSize = useUIStateStore((state) => state.layout.fontSize);

    useEffect(() => {
        applyChatTextSize(chatTextSize);
    }, [chatTextSize]);

    // The shell is read inside the effects, not through a hook: a hook reads "no shell" in the hydration pass, and an
    // effect run with that value would undo the boot script's native font and accent for a frame.
    useEffect(() => {
        const accent = effectiveAccent(accentColor, accentExplicit, hasNativeCapability("system-accent"));

        if (accent !== SYSTEM_ACCENT) {
            applyAccentAttribute(accent);
            applySystemAccentTokens(null);

            return undefined;
        }

        // The OS accent arrives over IPC; until then the boot script's cached copy (or the default preset) shows.
        let disposed = false;
        const apply = (hex: string | null): void => {
            if (disposed) {
                return;
            }

            const tokens = hex === null ? null : systemAccentTokens(hex);

            applySystemAccentTokens(tokens);
            cacheSystemAccentTokens(tokens);
            applyAccentAttribute(tokens === null ? DEFAULT_ACCENT : SYSTEM_ACCENT);
        };

        void getNativeSystemAccentColor().then(apply);
        const stop = onNativeSystemAccentColor(apply);

        return () => {
            disposed = true;
            stop();
        };
    }, [accentColor, accentExplicit]);

    useEffect(() => {
        const systemPreference = globalThis.matchMedia(PREFERS_MORE_CONTRAST_QUERY);
        const apply = () => applyContrastAttribute(effectiveContrast(isContrastId(contrast) ? contrast : DEFAULT_CONTRAST, systemPreference.matches));

        apply();
        systemPreference.addEventListener("change", apply);

        return () => systemPreference.removeEventListener("change", apply);
    }, [contrast]);

    useEffect(() => {
        applyRootAttribute(DENSITY_ATTRIBUTE, isDensityId(density) ? density : DEFAULT_DENSITY, DEFAULT_DENSITY);
    }, [density]);

    useEffect(() => {
        applyRootAttribute(FONT_ATTRIBUTE, effectiveMainFont(mainFont, fontExplicit, isNativeShell()), DEFAULT_MAIN_FONT);
    }, [mainFont, fontExplicit]);

    useEffect(() => {
        setStreamdownAppearance({
            // Absent is the default for each: the cap is on, line numbers are off.
            capLongCodeBlocks: capLongCodeBlocks !== false,
            codeLineNumbers: codeLineNumbers === true,
            mermaidTheme: isMermaidThemeId(mermaidTheme) ? mermaidTheme : "default",
            shikiTheme: CODE_HIGHLIGHT_THEMES[isCodeHighlightThemeId(codeHighlightTheme) ? codeHighlightTheme : "default"],
        });
    }, [capLongCodeBlocks, codeHighlightTheme, codeLineNumbers, mermaidTheme]);

    const crpc = useCRPC();
    const { data: sessionData } = authClient.useSession();
    const afterFirstPaint = useAfterFirstPaint();
    const { data: userSettings } = useQuery(crpc.auth.functions.getUserSettings.queryOptions(afterFirstPaint && sessionData?.user?.id ? {} : skipToken));

    const storedAccent = userSettings?.accentColor;
    const storedCodeTheme = userSettings?.codeHighlightTheme;
    const storedMermaidTheme = userSettings?.mermaidTheme;
    const storedContrast = userSettings?.contrast;
    const storedDensity = userSettings?.density;
    const storedMainFont = userSettings?.mainFont;
    const storedCapLongCodeBlocks = userSettings?.capLongCodeBlocks;
    const storedCodeLineNumbers = userSettings?.codeLineNumbers;

    useEffect(() => {
        const changes: Parameters<typeof setAppearance>[0] = {};
        const current = useUIStateStore.getState().appearance;
        const marked = { ...current.explicit };

        // A stored value is a choice the user made on some device. `system` is this device's own choice, so a
        // synced preset does not replace it.
        if (isAccentId(storedAccent) && current.accentColor !== SYSTEM_ACCENT) {
            changes.accentColor = storedAccent;
            marked.accentColor = true;
        }

        if (typeof storedCapLongCodeBlocks === "boolean") {
            changes.capLongCodeBlocks = storedCapLongCodeBlocks;
        }

        if (typeof storedCodeLineNumbers === "boolean") {
            changes.codeLineNumbers = storedCodeLineNumbers;
        }

        if (isCodeHighlightThemeId(storedCodeTheme)) {
            changes.codeHighlightTheme = storedCodeTheme;
        }

        if (isMermaidThemeId(storedMermaidTheme)) {
            changes.mermaidTheme = storedMermaidTheme;
        }

        if (isContrastId(storedContrast)) {
            changes.contrast = storedContrast;
        }

        if (isDensityId(storedDensity)) {
            changes.density = storedDensity;
        }

        if (isMainFontId(storedMainFont)) {
            changes.mainFont = storedMainFont;
            marked.mainFont = true;
        }

        if (Object.keys(changes).length > 0) {
            setAppearance({ ...changes, explicit: marked });
        }
    }, [
        storedAccent,
        storedCapLongCodeBlocks,
        storedCodeLineNumbers,
        storedCodeTheme,
        storedContrast,
        storedDensity,
        storedMainFont,
        storedMermaidTheme,
        setAppearance,
    ]);

    return null;
};

export default AppearanceSync;
