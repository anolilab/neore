import { HeadingLevelProvider } from "@neore/ui/components/heading";
import type { HeadingLevel } from "@neore/ui/components/heading-context";
import { useHeadingLevel } from "@neore/ui/components/heading-context";
import cn from "@neore/ui/utils/cn";
import type { FC, ReactNode } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";

/**
 * A card with a single field carries its title and description in the row, so the box has one heading. The card's own
 * header is hidden (its title and description are not passed to the card).
 */
export const hideCardHeader = (classNames?: SettingsCardClassNames): SettingsCardClassNames => {
    return { ...classNames, header: cn(classNames?.header, "hidden") };
};

export interface SettingsFieldRowProperties {
    /** The field. It is as wide as the row when stacked, and a fixed width beside the title. */
    children: ReactNode;
    description?: ReactNode;
    /** Help text for the field, under the description. */
    instructions?: ReactNode;
    title: ReactNode;
}

/**
 * The row's title is the section's heading (the card shows no title of its own), so it sits one level up: under the
 * tab's heading, not under a card title that is not there.
 */
const SettingsFieldRow: FC<SettingsFieldRowProperties> = ({ children, description, instructions, title }) => {
    const level = useHeadingLevel();

    return (
        <HeadingLevelProvider level={level === undefined ? undefined : (Math.max(2, level - 1) as HeadingLevel)}>
            <SettingsRow
                control={<div className="w-full @lg/settings-row:w-72">{children}</div>}
                description={
                    instructions ? (
                        <>
                            {description}
                            <span className="mt-1 block">{instructions}</span>
                        </>
                    ) : (
                        description
                    )
                }
                title={title}
            />
        </HeadingLevelProvider>
    );
};

export default SettingsFieldRow;
