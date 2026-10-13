import type { HighlightTheme } from "@tanstack/highlight/theme";
import githubDark from "@tanstack/highlight/themes/github-dark";
import githubLight from "@tanstack/highlight/themes/github-light";
import oneDarkPro from "@tanstack/highlight/themes/one-dark-pro";
import solarizedDark from "@tanstack/highlight/themes/solarized-dark";
import solarizedLight from "@tanstack/highlight/themes/solarized-light";

/**
 * The code-block themes the Appearance settings offer, by the NAME the settings store
 * (`code-themes.ts` in the web app pairs them as `[light, dark]`).
 *
 * The names are the ones Shiki used, so stored preferences and
 * `backend/lunora/auth/fields.ts` stay valid. TanStack Highlight ships five of them; the
 * rest are approximated from each theme's main colours below. A highlighter this small has
 * 21 token classes where a TextMate theme has hundreds of scopes, so an approximation is as
 * close as any port gets.
 */

type Palette = {
    background: string;
    comment: string;
    foreground: string;
    function: string;
    keyword: string;
    meta?: string;
    number: string;
    operator: string;
    property: string;
    string: string;
    tag: string;
    type: string;
    variable: string;
};

const fromPalette = (name: string, kind: HighlightTheme["type"], palette: Palette): HighlightTheme => {
    return {
        background: palette.background,
        foreground: palette.foreground,
        name,
        tokens: {
            attr: palette.property,
            "code-inline": palette.string,
            command: palette.function,
            comment: palette.comment,
            deleted: palette.keyword,
            function: palette.function,
            heading: palette.keyword,
            inserted: palette.string,
            keyword: palette.keyword,
            link: palette.string,
            literal: palette.number,
            meta: palette.meta ?? palette.comment,
            number: palette.number,
            operator: palette.operator,
            property: palette.property,
            selector: palette.tag,
            string: palette.string,
            tag: palette.tag,
            token: palette.foreground,
            type: palette.type,
            variable: palette.variable,
        },
        type: kind,
    };
};

const catppuccinLatte = fromPalette("catppuccin-latte", "light", {
    background: "#eff1f5",
    comment: "#9ca0b0",
    foreground: "#4c4f69",
    function: "#1e66f5",
    keyword: "#8839ef",
    meta: "#7c7f93",
    number: "#fe640b",
    operator: "#04a5e5",
    property: "#1e66f5",
    string: "#40a02b",
    tag: "#1e66f5",
    type: "#df8e1d",
    variable: "#4c4f69",
});

const catppuccinMocha = fromPalette("catppuccin-mocha", "dark", {
    background: "#1e1e2e",
    comment: "#6c7086",
    foreground: "#cdd6f4",
    function: "#89b4fa",
    keyword: "#cba6f7",
    meta: "#9399b2",
    number: "#fab387",
    operator: "#89dceb",
    property: "#89b4fa",
    string: "#a6e3a1",
    tag: "#89b4fa",
    type: "#f9e2af",
    variable: "#cdd6f4",
});

const minLight = fromPalette("min-light", "light", {
    background: "#ffffff",
    comment: "#6a737d",
    foreground: "#24292e",
    function: "#6f42c1",
    keyword: "#d32f2f",
    number: "#1976d2",
    operator: "#d32f2f",
    property: "#1976d2",
    string: "#2b5581",
    tag: "#22863a",
    type: "#1976d2",
    variable: "#e36209",
});

const minDark = fromPalette("min-dark", "dark", {
    background: "#1f1f1f",
    comment: "#6b737c",
    foreground: "#b392f0",
    function: "#b392f0",
    keyword: "#f97583",
    number: "#79b8ff",
    operator: "#f97583",
    property: "#79b8ff",
    string: "#9db1c5",
    tag: "#85e89d",
    type: "#79b8ff",
    variable: "#ffab70",
});

const oneLight = fromPalette("one-light", "light", {
    background: "#fafafa",
    comment: "#a0a1a7",
    foreground: "#383a42",
    function: "#4078f2",
    keyword: "#a626a4",
    number: "#986801",
    operator: "#0184bc",
    property: "#e45649",
    string: "#50a14f",
    tag: "#e45649",
    type: "#c18401",
    variable: "#e45649",
});

const poimandres = fromPalette("poimandres", "dark", {
    background: "#1b1e28",
    comment: "#767c9d",
    foreground: "#a6accd",
    function: "#5de4c7",
    keyword: "#add7ff",
    number: "#5de4c7",
    operator: "#add7ff",
    property: "#91b4d5",
    string: "#5de4c7",
    tag: "#add7ff",
    type: "#d0679d",
    variable: "#e4f0fb",
});

const vitesseLight = fromPalette("vitesse-light", "light", {
    background: "#ffffff",
    comment: "#a0ada0",
    foreground: "#393a34",
    function: "#59873a",
    keyword: "#1e754f",
    number: "#2f798a",
    operator: "#ab5959",
    property: "#998418",
    string: "#b56959",
    tag: "#1c6b48",
    type: "#2e8f82",
    variable: "#b07d48",
});

const vitesseDark = fromPalette("vitesse-dark", "dark", {
    background: "#121212",
    comment: "#758575",
    foreground: "#dbd7ca",
    function: "#80a665",
    keyword: "#4d9375",
    number: "#4c9a91",
    operator: "#cb7676",
    property: "#b8a965",
    string: "#c98a7d",
    tag: "#4d9375",
    type: "#5eaab5",
    variable: "#bd976a",
});

const THEMES: ReadonlyArray<HighlightTheme> = [
    catppuccinLatte,
    catppuccinMocha,
    githubDark as HighlightTheme,
    githubLight as HighlightTheme,
    minDark,
    minLight,
    oneDarkPro as HighlightTheme,
    oneLight,
    poimandres,
    solarizedDark as HighlightTheme,
    solarizedLight as HighlightTheme,
    vitesseDark,
    vitesseLight,
];

const BY_NAME: ReadonlyMap<string, HighlightTheme> = new Map(THEMES.map((theme) => [theme.name, theme]));

/** The theme a stored name refers to, or the GitHub one of the slot's kind when the name is unknown. */
export const resolveCodeTheme = (name: unknown, fallback: "dark" | "light"): HighlightTheme =>
    (typeof name === "string" ? BY_NAME.get(name) : undefined) ?? (fallback === "dark" ? (githubDark as HighlightTheme) : (githubLight as HighlightTheme));

export const CODE_THEME_NAMES: ReadonlyArray<string> = THEMES.map((theme) => theme.name);
