/**
 * `next-themes` for Storybook. The theme is the toolbar's, so the provider only hands it to
 * `useTheme`. The real provider renders an inline boot script, which React reports as an
 * error on every client render.
 */
import type { ReactNode } from "react";
import { createContext, use, useMemo } from "react";

interface ThemeState {
    forcedTheme?: string;
    resolvedTheme?: string;
    setTheme: (theme: string) => void;
    systemTheme?: "dark" | "light";
    theme?: string;
    themes: string[];
}

const THEMES = ["light", "dark", "system"];

const ThemeContext = createContext<ThemeState>({ setTheme: () => undefined, themes: THEMES });

const noop = (): void => {};

export const ThemeProvider = ({ children, forcedTheme }: { children: ReactNode; forcedTheme?: string }) => {
    const value = useMemo<ThemeState>(() => {
        return { forcedTheme, resolvedTheme: forcedTheme, setTheme: noop, systemTheme: "light", theme: forcedTheme, themes: THEMES };
    }, [forcedTheme]);

    return <ThemeContext value={value}>{children}</ThemeContext>;
};

export const useTheme = (): ThemeState => use(ThemeContext);
