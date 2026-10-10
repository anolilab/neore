import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";
import { useId } from "react";

import { THREAD_TAG_DOT_CLASSES } from "./thread-tag-colors";
import type { ThreadTagColor } from "./thread-tag-logic";
import { THREAD_TAG_COLORS } from "./thread-tag-logic";

/** Translated, human-readable name for each palette key. */
export const useThreadTagColorLabels = (): Record<ThreadTagColor, string> => {
    const { t } = useLingui();

    return {
        amber: t`Amber`,
        blue: t`Blue`,
        gray: t`Gray`,
        green: t`Green`,
        orange: t`Orange`,
        pink: t`Pink`,
        red: t`Red`,
        teal: t`Teal`,
        violet: t`Violet`,
    };
};

interface ThreadTagColorPickerProperties {
    /** Accessible name for the whole group, e.g. "Color for Work". */
    label: string;
    /** Unique radio-group name; one per picker on the page. */
    name: string;
    onChange: (color: ThreadTagColor) => void;
    value: ThreadTagColor;
}

/**
 * Swatch picker built on native radio inputs, so arrow-key navigation and the
 * checked state come from the browser rather than hand-rolled ARIA.
 */
const ThreadTagColorPicker: FC<ThreadTagColorPickerProperties> = ({ label, name, onChange, value }) => {
    const colorLabels = useThreadTagColorLabels();
    const idPrefix = useId();

    return (
        <fieldset className="flex flex-wrap items-center gap-1.5">
            <legend className="sr-only">{label}</legend>
            {THREAD_TAG_COLORS.map((color) => (
                <label className="relative flex cursor-pointer items-center" htmlFor={`${idPrefix}-${color}`} key={color} title={colorLabels[color]}>
                    <input
                        checked={value === color}
                        className="peer sr-only"
                        id={`${idPrefix}-${color}`}
                        name={name}
                        onChange={() => {
                            onChange(color);
                        }}
                        type="radio"
                        value={color}
                    />
                    <span
                        aria-hidden="true"
                        className={cn(
                            "ring-offset-background peer-focus-visible:ring-ring size-5 rounded-full ring-offset-2 peer-checked:ring-2 peer-checked:ring-current peer-focus-visible:ring-2",
                            THREAD_TAG_DOT_CLASSES[color],
                        )}
                    />
                    <span className="sr-only">{colorLabels[color]}</span>
                </label>
            ))}
        </fieldset>
    );
};

export default ThreadTagColorPicker;
