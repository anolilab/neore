import { useLingui } from "@lingui/react/macro";
import { m } from "motion/react";

import { fade, loop, useReduce } from "./timeline";
import { VisualFrame } from "./visual-frame";

/** Five slots across the loop. A run appears just after the playhead passes its slot. */
const SLOTS = [
    { id: "mon", at: 0.1, skipped: false },
    { id: "tue", at: 0.28, skipped: false },
    { id: "wed", at: 0.46, skipped: true },
    { id: "thu", at: 0.64, skipped: false },
    { id: "fri", at: 0.82, skipped: false },
] as const;

export const RoutinesVisual = () => {
    const { t } = useLingui();
    const reduce = useReduce();
    const dayLabel = { fri: t`Fri`, mon: t`Mon`, thu: t`Thu`, tue: t`Tue`, wed: t`Wed` };

    return (
        <VisualFrame
            label={t`A weekly routine. A playhead moves along the week; each slot shows its run, and the Wednesday run is skipped because the last one was still going.`}
        >
            <div className="relative h-10">
                <div className="absolute top-1/2 right-0 left-0 h-px bg-white/15" />
                {SLOTS.map((slot) => (
                    <div
                        className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/50"
                        key={slot.id}
                        style={{ left: `${slot.at * 100}%` }}
                    />
                ))}
                {/* The layer is as wide as the track, so moving it by 100% of its own width crosses the whole track. */}
                <m.div className="absolute inset-y-0 left-0 w-full" {...loop([0, 1], { opacity: [1, 1], x: ["0%", "100%"] }, { opacity: 0, x: "0%" }, reduce)}>
                    <div className="absolute top-1/2 left-0 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgba(255,255,255,0.12)]" />
                </m.div>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
                {SLOTS.map((slot) => (
                    <m.div
                        className="flex flex-col gap-1 rounded-lg border border-white/10 bg-black/40 p-2"
                        key={slot.id}
                        {...fade(slot.at + 0.02, 0.9, reduce)}
                    >
                        <span className="text-[11px] font-medium text-white/80">{dayLabel[slot.id]}</span>
                        {slot.skipped ? (
                            <span className="text-[10px] leading-tight text-amber-200/90">{t`Skipped: still running`}</span>
                        ) : (
                            <span className="text-[10px] leading-tight text-emerald-300/90">{t`Passed check`}</span>
                        )}
                    </m.div>
                ))}
            </div>
        </VisualFrame>
    );
};
