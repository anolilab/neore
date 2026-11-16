import { useLingui } from "@lingui/react/macro";
import { MousePointer2 } from "lucide-react";
import { m } from "motion/react";

import { fade, loop, useReduce } from "./timeline";
import { VisualFrame } from "./visual-frame";

export const ApprovalsVisual = () => {
    const { t } = useLingui();
    const reduce = useReduce();

    return (
        <VisualFrame label={t`An approval card asks to allow a tool. A pointer clicks Approve, the status changes to running, and the result appears.`}>
            <div className="rounded-xl border border-amber-300/25 bg-amber-300/[0.05] p-4">
                <p className="text-sm font-medium text-white">{t`Allow "delete_files" from the drafts server?`}</p>
                <p className="mt-1 text-xs text-white/50">{t`Deletes 3 files in /drafts`}</p>

                <div className="relative mt-3 h-5 text-xs">
                    <m.p className="absolute inset-0 text-amber-200" {...fade(0.05, 0.4, reduce, 0)}>
                        {t`Waiting for your approval`}
                    </m.p>
                    <m.p className="absolute inset-0 text-sky-200" {...fade(0.42, 0.92, reduce)}>
                        {t`Approved — running tool`}
                    </m.p>
                </div>

                <div className="relative mt-4 flex flex-wrap gap-2">
                    <m.span
                        className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black"
                        {...loop([0, 0.4, 0.44, 0.48, 1], { scale: [1, 1, 0.94, 1, 1] }, { scale: 1 }, reduce)}
                    >
                        {t`Approve`}
                    </m.span>
                    <span className="rounded-md border border-white/20 px-3 py-1.5 text-xs text-white/70">{t`Deny`}</span>
                    <span className="rounded-md px-3 py-1.5 text-xs text-white/50">{t`Always allow`}</span>
                    {/* The layer spans the button row, so moving it by a percentage of its own width crosses the row. */}
                    <m.span
                        className="pointer-events-none absolute inset-x-0 -top-2 text-white"
                        {...loop([0, 0.3, 0.5, 0.9, 1], { opacity: [0, 1, 1, 0, 0], x: ["80%", "6%", "6%", "80%", "80%"] }, { opacity: 0, x: "6%" }, reduce)}
                    >
                        <MousePointer2 className="size-4 fill-white" />
                    </m.span>
                </div>

                <m.p className="mt-4 text-xs text-white/70" {...fade(0.56, 0.92, reduce)}>
                    {t`Done. 3 files moved to the trash.`}
                </m.p>
            </div>
        </VisualFrame>
    );
};
