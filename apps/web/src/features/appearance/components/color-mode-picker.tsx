"use client";

import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useLingui } from "@lingui/react/macro";
import { Label } from "@neore/ui/components/label";
import cn from "@neore/ui/utils/cn";
import { useTheme } from "next-themes";
import type { FC } from "react";

const COLOR_MODE_LABEL_ID = "color-mode-label";

type ColorMode = "dark" | "light" | "system";

const isColorMode = (value: unknown): value is ColorMode => typeof value === "string" && ["dark", "light", "system"].includes(value);

/**
 * A miniature of the shell in one mode: the canvas, the sidebar rail and the raised page panel. The two palettes are written out
 * because a tile must show a mode other than the one the page is in (there is no token scope for "light" inside a dark page).
 */
const Preview: FC<{ mode: "dark" | "light" }> = ({ mode }) => {
    const isDark = mode === "dark";

    return (
        <span aria-hidden="true" className={cn("flex h-full w-full gap-1 p-1.5", isDark ? "bg-[#0e0f11]" : "bg-[#f0efeb]")}>
            <span className={cn("w-1/4 rounded-sm", isDark ? "bg-[#d6e0ff]/10" : "bg-[#191919]/10")} />
            <span className={cn("flex flex-1 flex-col gap-1 rounded-sm p-1", isDark ? "bg-[#121316]" : "bg-[#fffefc]")}>
                <span className={cn("h-1 w-2/3 rounded-full", isDark ? "bg-[#d6e0ff]/40" : "bg-[#191919]/40")} />
                <span className={cn("h-1 w-1/2 rounded-full", isDark ? "bg-[#d6e0ff]/20" : "bg-[#191919]/20")} />
            </span>
        </span>
    );
};

/** System, Light or Dark as three preview tiles (a radio group), on the same theme state as the header toggle. */
const ColorModePicker: FC = () => {
    const { t } = useLingui();
    const { setTheme, theme } = useTheme();

    const options: { id: ColorMode; label: string }[] = [
        { id: "system", label: t`System` },
        { id: "light", label: t`Light` },
        { id: "dark", label: t`Dark` },
    ];

    return (
        <div className="space-y-2">
            <Label className="text-base font-medium" id={COLOR_MODE_LABEL_ID}>
                {t`Color mode`}
            </Label>
            <RadioGroup
                aria-labelledby={COLOR_MODE_LABEL_ID}
                className="flex flex-wrap gap-3"
                onValueChange={(next) => {
                    if (isColorMode(next)) {
                        setTheme(next);
                    }
                }}
                value={isColorMode(theme) ? theme : "system"}
            >
                {options.map((option) => (
                    // eslint-disable-next-line jsx-a11y/label-has-associated-control -- Radio.Root renders the control inside this label
                    <label className="group flex cursor-pointer flex-col gap-1.5" key={option.id}>
                        <Radio.Root
                            className="border-border/50 data-checked:border-primary data-checked:ring-primary/30 focus-visible:outline-ring relative h-14 w-24 overflow-hidden rounded-lg border outline-offset-2 focus-visible:outline-2 data-checked:ring-2"
                            value={option.id}
                        >
                            {option.id === "system" ? (
                                <span aria-hidden="true" className="flex h-full w-full">
                                    <span className="h-full w-1/2 overflow-hidden">
                                        <span className="block h-full w-[200%]">
                                            <Preview mode="light" />
                                        </span>
                                    </span>
                                    <span className="h-full w-1/2 overflow-hidden">
                                        <span className="block h-full w-[200%] -translate-x-1/2">
                                            <Preview mode="dark" />
                                        </span>
                                    </span>
                                </span>
                            ) : (
                                <Preview mode={option.id} />
                            )}
                        </Radio.Root>
                        <span className="text-muted-foreground group-has-data-checked:text-foreground text-xs group-has-data-checked:font-medium">
                            {option.label}
                        </span>
                    </label>
                ))}
            </RadioGroup>
        </div>
    );
};

export default ColorModePicker;
