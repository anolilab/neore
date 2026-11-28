import { Heading } from "@neore/ui/components/heading";
import { Label } from "@neore/ui/components/label";
import cn from "@neore/ui/utils/cn";
import type { FC, ReactNode } from "react";

export interface SettingsRowProperties {
    /** Content under the row that needs the full width: a radio group, a list of swatches, a preview. */
    children?: ReactNode;
    className?: string;
    /** The control: a switch, a select, a button. It sits right of the title when the row is wide enough. */
    control?: ReactNode;
    description?: ReactNode;
    /** The description's id, for a control that points at it with `aria-describedby`. */
    descriptionId?: string;
    /** The id of the control the title labels, so a click on the title and the settings search reach it. */
    htmlFor?: string;
    title: ReactNode;
    /** The title's id, for a control that is named through `aria-labelledby` (a radio group) rather than `htmlFor`. */
    titleId?: string;
}

/**
 * One setting in a settings box (`SettingsCard`): its title and description on the left, its control on the right, a
 * hairline above every row but the first. The row decides its layout from its own width, not the window's, so it stacks
 * in a narrow modal as it does on a phone.
 *
 * `data-slot="settings-row"` is what the settings search outlines and scrolls to (`settings-jump.ts`).
 */
const SettingsRow: FC<SettingsRowProperties> = ({ children, className, control, description, descriptionId, htmlFor, title, titleId }) => (
    <div className={cn("@container/settings-row not-first:border-border/50 my-0 py-3 not-first:border-t", className)} data-slot="settings-row">
        <div className="flex flex-col gap-3 @lg/settings-row:grid @lg/settings-row:grid-cols-[minmax(0,1fr)_auto] @lg/settings-row:items-center @lg/settings-row:gap-8">
            <div className="min-w-0 space-y-1">
                {htmlFor ? (
                    <Label className="text-sm font-medium" htmlFor={htmlFor} id={titleId}>
                        {title}
                    </Label>
                ) : (
                    // A heading one level under the card's title, so the search and a screen reader's heading list both find it.
                    <Heading className="text-sm font-medium" fallbackLevel={3} id={titleId}>
                        {title}
                    </Heading>
                )}
                {description && (
                    <p className="text-muted-foreground max-w-2xl text-xs leading-normal text-pretty" id={descriptionId}>
                        {description}
                    </p>
                )}
            </div>
            {control && (
                <div className="flex min-w-0 flex-wrap items-center gap-2 @lg/settings-row:justify-end [&_[data-slot=select-trigger]]:min-w-40">{control}</div>
            )}
        </div>
        {children && <div className="pt-3">{children}</div>}
    </div>
);

export default SettingsRow;
