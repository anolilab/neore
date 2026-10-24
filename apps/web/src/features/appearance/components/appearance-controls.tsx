"use client";

import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useLingui } from "@lingui/react/macro";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Switch } from "@neore/ui/components/switch";
import { CheckIcon } from "lucide-react";
import type { FC } from "react";
import { useMemo } from "react";
import { toast } from "sonner";

import { useAppearanceSettings, useLayoutState } from "@/features/layout/hooks/use-ui-state";

import type { AccentId } from "../lib/accent-presets";
import { ACCENT_PRESETS, isAccentId } from "../lib/accent-presets";
import type { ChatTextSize } from "../lib/chat-text-size";
import { CHAT_TEXT_SIZES, isChatTextSize } from "../lib/chat-text-size";
import type { CodeHighlightThemeId, MermaidThemeId } from "../lib/code-themes";
import { CODE_HIGHLIGHT_THEME_IDS, isCodeHighlightThemeId, isMermaidThemeId, MERMAID_THEME_IDS } from "../lib/code-themes";
import type { ContrastId, DensityId, MainFontId } from "../lib/display-preferences";
import { DEFAULT_CONTRAST, isContrastId, isDensityId, isMainFontId } from "../lib/display-preferences";

const ACCENT_LABEL_ID = "accent-color-label";
const CONTRAST_LABEL_ID = "ui-contrast-label";
const DENSITY_LABEL_ID = "ui-density-label";
const FONT_LABEL_ID = "ui-font-label";

/**
 * One named radio per option (arrow keys move, the text names it). Shared by
 * the density and font groups; the accent group draws colour swatches instead.
 */
const ChoiceRadioGroup = <T extends string>({
    labelId,
    onChange,
    options,
    value,
}: {
    labelId: string;
    onChange: (value: T) => void;
    options: { id: T; label: string }[];
    value: T;
}) => (
    <RadioGroup
        aria-labelledby={labelId}
        className="flex flex-wrap gap-x-4 gap-y-2"
        onValueChange={(next) => {
            if (typeof next === "string") {
                onChange(next as T);
            }
        }}
        value={value}
    >
        {options.map((option) => (
            // eslint-disable-next-line jsx-a11y/label-has-associated-control -- Radio.Root renders the control inside this label
            <label className="group flex cursor-pointer items-center gap-2 text-sm" key={option.id}>
                <Radio.Root
                    className="border-border data-checked:border-primary focus-visible:outline-ring relative flex size-4 shrink-0 items-center justify-center rounded-full border outline-offset-4 focus-visible:outline-2"
                    value={option.id}
                >
                    <Radio.Indicator className="bg-primary size-2 rounded-full" />
                </Radio.Root>
                <span className="group-has-data-checked:font-medium">{option.label}</span>
            </label>
        ))}
    </RadioGroup>
);

/**
 * Accent colour swatches (a Base UI radio group: arrow keys move, each option
 * is named in text, never by colour alone), UI density and font family with a
 * live preview, and the code-highlight and Mermaid theme selects. Rendered
 * inside the Appearance card.
 */
const AppearanceControls: FC = () => {
    const { t } = useLingui();
    const {
        accentColor,
        capLongCodeBlocks,
        codeHighlightTheme,
        codeLineNumbers,
        contrast,
        density,
        mainFont,
        mermaidTheme,
        setAccentColor,
        setCapLongCodeBlocks,
        setCodeHighlightTheme,
        setCodeLineNumbers,
        setContrast,
        setDensity,
        setMainFont,
        setMermaidTheme,
    } = useAppearanceSettings();

    const contrastOptions = useMemo<{ id: ContrastId; label: string }[]>(
        () => [
            { id: "system", label: t`Follow my system (default)` },
            { id: "standard", label: t`Standard` },
            { id: "high", label: t`High contrast` },
        ],
        [t],
    );

    const densityOptions = useMemo<{ id: DensityId; label: string }[]>(
        () => [
            { id: "compact", label: t`Compact` },
            { id: "comfortable", label: t`Comfortable (default)` },
            { id: "spacious", label: t`Spacious` },
        ],
        [t],
    );

    const fontOptions = useMemo<{ id: MainFontId; label: string }[]>(
        () => [
            { id: "inter", label: t`Sans (default)` },
            { id: "serif", label: t`Serif` },
            { id: "mono", label: t`Monospace` },
            { id: "system", label: t`System UI` },
            { id: "dyslexic", label: t`Dyslexia-friendly` },
        ],
        [t],
    );

    const { fontSize, setFontSize } = useLayoutState();

    const textSizeLabels = useMemo<Record<ChatTextSize, string>>(() => {
        return {
            large: t`Large`,
            medium: t`Medium (default)`,
            small: t`Small`,
        };
    }, [t]);

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
                <Label className="text-base font-medium" id={CONTRAST_LABEL_ID}>
                    {t`Contrast`}
                </Label>
                <p className="text-muted-foreground text-sm">
                    {t`High contrast uses black and white text, stronger borders and a heavier focus ring. By default it follows your system's contrast setting.`}
                </p>
                <ChoiceRadioGroup
                    labelId={CONTRAST_LABEL_ID}
                    onChange={(value) => {
                        if (!isContrastId(value)) {
                            return;
                        }

                        setContrast(value);
                        toast.success(t`Contrast updated`);
                    }}
                    options={contrastOptions}
                    value={contrast ?? DEFAULT_CONTRAST}
                />
            </div>
            <div className="space-y-2">
                <Label className="text-base font-medium" id={DENSITY_LABEL_ID}>
                    {t`Density`}
                </Label>
                <p className="text-muted-foreground text-sm">{t`Spacing between messages, in chat bubbles and in the thread list.`}</p>
                <ChoiceRadioGroup
                    labelId={DENSITY_LABEL_ID}
                    onChange={(value) => {
                        if (!isDensityId(value)) {
                            return;
                        }

                        setDensity(value);
                        toast.success(t`Density updated`);
                    }}
                    options={densityOptions}
                    value={density}
                />
                {/* The sample sits under the page's own tokens (data-density is on the wrapper too, so it shows the choice at once). */}
                <div aria-hidden="true" className="border-border bg-background rounded-xl border p-4 text-sm" data-density={density}>
                    <div className="flex justify-end pb-(--density-message-gap)">
                        <p className="bg-muted rounded-3xl px-5 py-(--density-bubble-py)">{t`Summarise my notes in three bullets.`}</p>
                    </div>
                    <p className="px-1 py-(--density-bubble-py)">{t`Here they are: planning, budget and next steps.`}</p>
                </div>
            </div>
            <div className="space-y-2">
                <Label className="text-base font-medium" id={FONT_LABEL_ID}>
                    {t`Font`}
                </Label>
                <p className="text-muted-foreground text-sm">{t`Typeface for the whole interface. Code blocks always stay monospace.`}</p>
                <ChoiceRadioGroup
                    labelId={FONT_LABEL_ID}
                    onChange={(value) => {
                        if (!isMainFontId(value)) {
                            return;
                        }

                        setMainFont(value);
                        toast.success(t`Font updated`);
                    }}
                    options={fontOptions}
                    value={mainFont}
                />
            </div>
            <div className="space-y-2">
                <Label className="text-base font-medium" htmlFor="chat-text-size">
                    {t`Chat Text Size`}
                </Label>
                <p className="text-muted-foreground text-sm">{t`Size of the text in chat messages. The sidebar and the rest of the app keep their size.`}</p>
                <Select
                    onValueChange={(value) => {
                        if (!isChatTextSize(value)) {
                            return;
                        }

                        setFontSize(value);
                        toast.success(t`Chat text size updated`);
                    }}
                    value={fontSize}
                >
                    <SelectTrigger id="chat-text-size">
                        <SelectValue>{(value: string | null) => (isChatTextSize(value) ? textSizeLabels[value] : value)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {CHAT_TEXT_SIZES.map((size) => (
                            <SelectItem key={size} value={size}>
                                {textSizeLabels[size]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
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
            <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                    <Label className="text-base font-medium" htmlFor="code-line-numbers">
                        {t`Line numbers in code blocks`}
                    </Label>
                    <p className="text-muted-foreground text-sm">{t`Number each line of code in chat replies. Off by default.`}</p>
                </div>
                <Switch
                    checked={codeLineNumbers === true}
                    id="code-line-numbers"
                    onCheckedChange={(checked) => {
                        setCodeLineNumbers(checked);
                        toast.success(checked ? t`Line numbers shown` : t`Line numbers hidden`);
                    }}
                />
            </div>
            <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                    <Label className="text-base font-medium" htmlFor="cap-long-code-blocks">
                        {t`Limit height of long code blocks`}
                    </Label>
                    <p className="text-muted-foreground text-sm">{t`Long code blocks scroll inside a fixed height until you expand them.`}</p>
                </div>
                <Switch
                    checked={capLongCodeBlocks !== false}
                    id="cap-long-code-blocks"
                    onCheckedChange={(checked) => {
                        setCapLongCodeBlocks(checked);
                        toast.success(checked ? t`Long code blocks limited` : t`Long code blocks shown in full`);
                    }}
                />
            </div>
        </>
    );
};

export default AppearanceControls;
