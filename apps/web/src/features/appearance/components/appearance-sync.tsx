"use client";

import { setStreamdownAppearance } from "@neore/ui/hooks/use-streamdown-appearance";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { authClient } from "@/lib/auth/client";
import { useCRPC } from "@/lib/lunora/crpc";
import { hasNativeCapability, isNativeShell } from "@/lib/native/bridge";

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
import type { SystemAccentTokens } from "../lib/native-appearance";
import {
    adoptedMark,
    applySystemAccentTokens,
    cacheSystemAccentTokens,
    effectiveAccent,
    effectiveMainFont,
    isExplicit,
    SYSTEM_ACCENT,
    withoutSyncedChoices,
} from "../lib/native-appearance";

/** How many times a failed load of the OS accent's chunk is retried. */
const ACCENT_CHUNK_RETRIES = 3;

/** Paints the OS accent tokens and caches them for the next boot; `null` (the OS has none) falls back to the default preset. */
const paintSystemAccent = (tokens: SystemAccentTokens | null): void => {
    applySystemAccentTokens(tokens);
    cacheSystemAccentTokens(tokens);
    applyAccentAttribute(tokens === null ? DEFAULT_ACCENT : SYSTEM_ACCENT);
};

/**
 * Loads the OS accent's chunk and follows the OS accent; returns the function that stops (a pending retry too). A
 * failed load keeps what is painted and is retried 1, 2 and 4 seconds later.
 */
const followSystemAccentChunk = (): (() => void) => {
    let disposed = false;
    let stop = (): void => {};
    let retry: ReturnType<typeof setTimeout> | undefined;

    const load = (attempt: number): void => {
        void import("../lib/system-accent-sync")
            .then(({ followSystemAccent }) => {
                if (!disposed) {
                    stop = followSystemAccent(paintSystemAccent);
                }

                return undefined;
            })
            .catch(() => {
                if (!disposed && attempt < ACCENT_CHUNK_RETRIES) {
                    retry = setTimeout(load, 1000 * 2 ** attempt, attempt + 1);
                }
            });
    };

    load(0);

    return () => {
        disposed = true;
        clearTimeout(retry);
        stop();
    };
};

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
 *   and first paint's query budget is not spent on it. What it adopts is marked
 *   `synced` for that account: another account signing in drops it, so the
 *   shell's defaults apply again where that account stored nothing.
 *
 * Kept out of the React Compiler (`"use no memo"`): it renders nothing, so memoizing its effects saves no work, and
 * the compiled form adds ~0.6 KiB gzip to the first load.
 */
const AppearanceSync = () => {
    "use no memo";

    const { accentColor, capLongCodeBlocks, codeHighlightTheme, codeLineNumbers, contrast, density, explicit, mainFont, mermaidTheme } = useUIStateStore(
        (state) => state.appearance,
    );
    const accentExplicit = isExplicit(explicit?.accentColor);
    const fontExplicit = isExplicit(explicit?.mainFont);
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

        // The OS accent arrives over IPC; until then the boot script's cached copy (or the default preset) shows. The
        // code that follows it loads only here, so the web build never downloads it.
        return followSystemAccentChunk();
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
    const { data: sessionData, error: sessionError, isPending: sessionPending } = authClient.useSession();
    const userId = sessionData?.user?.id;
    // An answered "no session": not while the read is pending, and not when it failed.
    const signedOut = !sessionPending && !sessionError && !sessionData?.user;
    const afterFirstPaint = useAfterFirstPaint();
    const { data: settingsRow } = useQuery(crpc.auth.functions.getUserSettings.queryOptions(afterFirstPaint && userId ? {} : skipToken));
    // The query key carries no user: right after an account switch it can still hold the last account's row.
    const userSettings = settingsRow?.userId === userId ? settingsRow : undefined;

    const storedAccent = userSettings?.accentColor;
    const storedCodeTheme = userSettings?.codeHighlightTheme;
    const storedMermaidTheme = userSettings?.mermaidTheme;
    const storedContrast = userSettings?.contrast;
    const storedDensity = userSettings?.density;
    const storedMainFont = userSettings?.mainFont;
    const storedCapLongCodeBlocks = userSettings?.capLongCodeBlocks;
    const storedCodeLineNumbers = userSettings?.codeLineNumbers;

    // Before adopting the account's settings, in the same commit: another account's synced accent and font go first.
    // Signing out drops them too; choices made on this device stay.
    useEffect(() => {
        const current = useUIStateStore.getState().appearance;

        if (userId === undefined) {
            if (signedOut && current.syncedUserId !== undefined) {
                setAppearance({ ...withoutSyncedChoices(current.explicit), syncedUserId: undefined });
            }

            return;
        }

        if (current.syncedUserId !== userId) {
            setAppearance({ ...withoutSyncedChoices(current.explicit), syncedUserId: userId });
        }
    }, [userId, signedOut, setAppearance]);

    useEffect(() => {
        const changes: Parameters<typeof setAppearance>[0] = {};
        const current = useUIStateStore.getState().appearance;
        const marked = { ...current.explicit };

        // A stored value is a choice the user made on some device. `system` is this device's own choice, so a
        // synced preset does not replace it.
        if (isAccentId(storedAccent) && current.accentColor !== SYSTEM_ACCENT) {
            changes.accentColor = storedAccent;
            marked.accentColor = adoptedMark(current.explicit?.accentColor, current.accentColor === storedAccent);
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
            marked.mainFont = adoptedMark(current.explicit?.mainFont, current.mainFont === storedMainFont);
        }

        if (Object.keys(changes).length > 0) {
            setAppearance({ ...changes, explicit: marked, syncedUserId: userId });
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
        // A new account re-adopts its settings after the effect above dropped the last one's, even where they match.
        userId,
    ]);

    return null;
};

export default AppearanceSync;
