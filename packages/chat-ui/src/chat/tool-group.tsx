import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@neore/ui/components/collapsible";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useState } from "react";

import type { ToolGroupSegment } from "./turn-summary";

const MAX_NAMES = 2;

/** One summary line for a finished run of tool calls; the per-call cards sit behind it. */
const ToolGroup: FC<{ children: ReactNode; group: ToolGroupSegment }> = ({ children, group }) => {
    const [open, setOpen] = useState(false);
    const shown = group.names.slice(0, MAX_NAMES);
    const more = group.names.slice(MAX_NAMES).reduce((sum, entry) => sum + entry.count, 0);
    const { t } = useLingui();
    const first = shown[0];
    const second = shown[1];
    // One message per shape, so translators get whole sentences and own the separators.
    const firstLabel = first?.name ?? "";
    const firstCount = first?.count ?? 0;
    const secondLabel = second?.name ?? "";
    const secondCount = second?.count ?? 0;
    const firstName = firstCount > 1 ? t`${firstLabel} ×${firstCount}` : firstLabel;
    const secondName = secondCount > 1 ? t`${secondLabel} ×${secondCount}` : secondLabel;
    const total = group.toolCount;
    const namesText = secondName ? t`${firstName}, ${secondName}` : firstName;
    const tail = more > 0 ? t`${namesText}, +${more} more` : namesText;
    const summary = t({ message: plural(total, { one: `Used # tool · ${tail}`, other: `Used # tools · ${tail}` }) });
    const Chevron = open ? ChevronDown : ChevronRight;

    return (
        <Collapsible className="mb-4" onOpenChange={setOpen} open={open}>
            <CollapsibleTrigger
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-11 w-full items-center gap-2 rounded-md py-1 text-left text-sm font-medium focus-visible:ring-2 sm:min-h-0"
                data-testid="tool-group-trigger"
            >
                <Chevron aria-hidden="true" className="size-4 shrink-0" />
                <Wrench aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 truncate">{summary}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
                <div className="pt-2">{children}</div>
            </CollapsibleContent>
        </Collapsible>
    );
};

export default ToolGroup;
