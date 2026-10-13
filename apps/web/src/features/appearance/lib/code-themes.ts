import type { StreamdownAppearance } from "@neore/ui/hooks/use-streamdown-appearance";
import { DEFAULT_STREAMDOWN_APPEARANCE } from "@neore/ui/hooks/use-streamdown-appearance";

/**
 * Code-block theme pairs and Mermaid themes offered in Appearance.
 *
 * Only theme NAMES are listed — never theme JSON. The code highlighter
 * (`@neore/ui/utils/code-highlighter`, on TanStack Highlight) looks each name up in its own
 * palettes (`code-highlight-themes.ts`), and the names are the ones Shiki used, so a stored
 * choice keeps its meaning. A name added here needs a palette there. The accepted ids are
 * mirrored in `backend/lunora/auth/fields.ts`.
 */

export const CODE_HIGHLIGHT_THEME_IDS = ["default", "github", "one", "vitesse", "catppuccin", "min", "solarized"] as const;

export type CodeHighlightThemeId = (typeof CODE_HIGHLIGHT_THEME_IDS)[number];

/** `[light, dark]`, the order Streamdown's `shikiTheme` takes. */
export const CODE_HIGHLIGHT_THEMES: Record<CodeHighlightThemeId, StreamdownAppearance["shikiTheme"]> = {
    catppuccin: ["catppuccin-latte", "catppuccin-mocha"],
    default: DEFAULT_STREAMDOWN_APPEARANCE.shikiTheme,
    github: ["github-light", "github-dark"],
    min: ["min-light", "min-dark"],
    one: ["one-light", "one-dark-pro"],
    solarized: ["solarized-light", "solarized-dark"],
    vitesse: ["vitesse-light", "vitesse-dark"],
};

export const MERMAID_THEME_IDS = ["default", "neutral", "dark", "forest", "base"] as const;

export type MermaidThemeId = (typeof MERMAID_THEME_IDS)[number];

const CODE_THEME_SET: ReadonlySet<string> = new Set(CODE_HIGHLIGHT_THEME_IDS);
const MERMAID_THEME_SET: ReadonlySet<string> = new Set(MERMAID_THEME_IDS);

export const isCodeHighlightThemeId = (value: unknown): value is CodeHighlightThemeId => typeof value === "string" && CODE_THEME_SET.has(value);

export const isMermaidThemeId = (value: unknown): value is MermaidThemeId => typeof value === "string" && MERMAID_THEME_SET.has(value);
