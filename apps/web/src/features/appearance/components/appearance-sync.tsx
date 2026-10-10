"use client";

import { setStreamdownAppearance } from "@neore/ui/hooks/use-streamdown-appearance";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { authClient } from "@/lib/auth/client";
import { useCRPC } from "@/lib/lunora/crpc";

import { applyAccentAttribute } from "../lib/accent-boot-script";
import { DEFAULT_ACCENT, isAccentId } from "../lib/accent-presets";
import { CODE_HIGHLIGHT_THEMES, isCodeHighlightThemeId, isMermaidThemeId } from "../lib/code-themes";

/**
 * Applies the Appearance settings app-wide; renders nothing.
 *
 * - The accent goes on `<html data-accent>` (the boot script already did so
 *   before first paint; this keeps it in step with later changes).
 * - The code / Mermaid themes are pushed to the Streamdown renderers.
 * - The account's stored choice (`userSettings`) is adopted when it arrives or
 *   changes, so it follows the user across devices. Deferred past first paint
 *   and skipped when signed out: localStorage already painted the right thing,
 *   and first paint's query budget is not spent on it.
 */
const AppearanceSync = () => {
    const { accentColor, codeHighlightTheme, mermaidTheme } = useUIStateStore((state) => state.appearance);
    const setAppearance = useUIStateStore((state) => state.setAppearance);

    useEffect(() => {
        applyAccentAttribute(isAccentId(accentColor) ? accentColor : DEFAULT_ACCENT);
    }, [accentColor]);

    useEffect(() => {
        setStreamdownAppearance({
            mermaidTheme: isMermaidThemeId(mermaidTheme) ? mermaidTheme : "default",
            shikiTheme: CODE_HIGHLIGHT_THEMES[isCodeHighlightThemeId(codeHighlightTheme) ? codeHighlightTheme : "default"],
        });
    }, [codeHighlightTheme, mermaidTheme]);

    const crpc = useCRPC();
    const { data: sessionData } = authClient.useSession();
    const afterFirstPaint = useAfterFirstPaint();
    const { data: userSettings } = useQuery(crpc.auth.functions.getUserSettings.queryOptions(afterFirstPaint && sessionData?.user?.id ? {} : skipToken));

    const storedAccent = userSettings?.accentColor;
    const storedCodeTheme = userSettings?.codeHighlightTheme;
    const storedMermaidTheme = userSettings?.mermaidTheme;

    useEffect(() => {
        const changes: Parameters<typeof setAppearance>[0] = {};

        if (isAccentId(storedAccent)) {
            changes.accentColor = storedAccent;
        }

        if (isCodeHighlightThemeId(storedCodeTheme)) {
            changes.codeHighlightTheme = storedCodeTheme;
        }

        if (isMermaidThemeId(storedMermaidTheme)) {
            changes.mermaidTheme = storedMermaidTheme;
        }

        if (Object.keys(changes).length > 0) {
            setAppearance(changes);
        }
    }, [storedAccent, storedCodeTheme, storedMermaidTheme, setAppearance]);

    return null;
};

export default AppearanceSync;
