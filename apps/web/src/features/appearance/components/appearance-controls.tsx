"use client";

import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useLingui } from "@lingui/react/macro";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { CheckIcon } from "lucide-react";
import type { FC } from "react";
import { useMemo } from "react";
import { toast } from "sonner";

import { useAppearanceSettings } from "@/features/layout/hooks/use-ui-state";

import type { AccentId } from "../lib/accent-presets";
import { ACCENT_PRESETS, isAccentId } from "../lib/accent-presets";
import type { CodeHighlightThemeId, MermaidThemeId } from "../lib/code-themes";
import { CODE_HIGHLIGHT_THEME_IDS, isCodeHighlightThemeId, isMermaidThemeId, MERMAID_THEME_IDS } from "../lib/code-themes";

const ACCENT_LABEL_ID = "accent-color-label";

/**
 * Accent colour swatches (a Base UI radio group: arrow keys move, each option
 * is named in text, never by colour alone) plus the code-highlight and
 * Mermaid theme selects. Rendered inside the Appearance card.
 */
const AppearanceControls: FC = () => {
    const { t } = useLingui();
    const { accentColor, codeHighlightTheme, mermaidTheme, setAccentColor, setCodeHighlightTheme, setMermaidTheme } = useAppearanceSettings();

    const accentLabels = useMemo<Record<AccentId, string>>(() => {
        return {
            blue: t`Blue`,
            default: t`Lime (default)`,
            green: t`Green`,
            orange: t`Orange`,
            rose: t`Rose`,
            teal: t`Teal`,
            violet: t`Violet`,
        };
    }, [t]);

    const codeThemeLabels = useMemo<Record<CodeHighlightThemeId, string>>(() => {
        return {
            catppuccin: t`Catppuccin`,
            default: t`Poimandres (default)`,
            github: t`GitHub`,
            min: t`Min`,
            one: t`One`,
            solarized: t`Solarized`,
            vitesse: t`Vitesse`,
        };
    }, [t]);

    const mermaidThemeLabels = useMemo<Record<MermaidThemeId, string>>(() => {
        return {
            base: t`Base`,
            dark: t`Dark`,
            default: t`Default`,
            forest: t`Forest`,
            neutral: t`Neutral`,
        };
    }, [t]);

    return (
        <>
            <div className="space-y-2">
                <Label className="text-base font-medium" id={ACCENT_LABEL_ID}>
                    {t`Accent Color`}
                </Label>
                <p className="text-muted-foreground text-sm">{t`Used for buttons, highlights and focus rings. Every option keeps text readable in light and dark mode.`}</p>
                <RadioGroup
                    aria-labelledby={ACCENT_LABEL_ID}
                    className="flex flex-wrap gap-x-4 gap-y-3"
                    onValueChange={(value) => {
                        if (!isAccentId(value)) {
                            return;
                        }

                        setAccentColor(value);
                        toast.success(t`Accent color updated`);
                    }}
                    value={accentColor}
                >
                    {ACCENT_PRESETS.map((preset) => (
                        // eslint-disable-next-line jsx-a11y/label-has-associated-control -- Radio.Root renders the control inside this label
                        <label className="group flex cursor-pointer items-center gap-2 text-sm" key={preset.id}>
                            <Radio.Root
                                className="border-border data-checked:ring-foreground focus-visible:outline-ring data-checked:ring-offset-background relative flex size-7 shrink-0 items-center justify-center rounded-full border outline-offset-4 focus-visible:outline-2 data-checked:ring-2 data-checked:ring-offset-2"
                                // Split swatch: the light-mode accent over the dark-mode one.
                                style={{ background: `linear-gradient(135deg, ${preset.light.primary} 50%, ${preset.dark.primary} 50%)` }}
                                value={preset.id}
                            >
                                <Radio.Indicator className="bg-background text-foreground flex size-4 items-center justify-center rounded-full">
                                    <CheckIcon aria-hidden="true" className="size-3" />
                                </Radio.Indicator>
                            </Radio.Root>
                            <span className="group-has-data-checked:font-medium">{accentLabels[preset.id]}</span>
                        </label>
                    ))}
                </RadioGroup>
            </div>
            <div className="space-y-2">
                <Label className="text-base font-medium" htmlFor="code-highlight-theme">
                    {t`Code Highlighting Theme`}
                </Label>
                <p className="text-muted-foreground text-sm">{t`Syntax colors for code blocks in chat. Each theme has a light and a dark variant.`}</p>
                <Select
                    onValueChange={(value) => {
                        if (!isCodeHighlightThemeId(value)) {
                            return;
                        }

                        setCodeHighlightTheme(value);
                        toast.success(t`Code highlighting theme updated`);
                    }}
                    value={codeHighlightTheme}
                >
                    <SelectTrigger id="code-highlight-theme">
                        <SelectValue>{(value: string | null) => (isCodeHighlightThemeId(value) ? codeThemeLabels[value] : value)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {CODE_HIGHLIGHT_THEME_IDS.map((id) => (
                            <SelectItem key={id} value={id}>
                                {codeThemeLabels[id]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="space-y-2">
                <Label className="text-base font-medium" htmlFor="mermaid-theme">
                    {t`Diagram Theme`}
                </Label>
                <p className="text-muted-foreground text-sm">{t`Theme for Mermaid diagrams in chat.`}</p>
                <Select
                    onValueChange={(value) => {
                        if (!isMermaidThemeId(value)) {
                            return;
                        }

                        setMermaidTheme(value);
                        toast.success(t`Diagram theme updated`);
                    }}
                    value={mermaidTheme}
                >
                    <SelectTrigger id="mermaid-theme">
                        <SelectValue>{(value: string | null) => (isMermaidThemeId(value) ? mermaidThemeLabels[value] : value)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {MERMAID_THEME_IDS.map((id) => (
                            <SelectItem key={id} value={id}>
                                {mermaidThemeLabels[id]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
        </>
    );
};

export default AppearanceControls;
