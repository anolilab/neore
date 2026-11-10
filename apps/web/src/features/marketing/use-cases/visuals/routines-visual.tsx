import { useLingui } from "@lingui/react/macro";
import { motion } from "motion/react";

import { fade, loop, useReduce } from "./timeline";
import { VisualFrame } from "./visual-frame";

/** Five slots across the loop. A run appears just after the playhead passes its slot. */
const SLOTS = [
    { day: "Mon", at: 0.1, skipped: false },
    { day: "Tue", at: 0.28, skipped: false },
    { day: "Wed", at: 0.46, skipped: true },
    { day: "Thu", at: 0.64, skipped: false },
    { day: "Fri", at: 0.82, skipped: false },
] as const;

export const RoutinesVisual = () => {
    const { t } = useLingui();
    const reduce = useReduce();

    return (
        <VisualFrame
            label={t`A weekly routine. A playhead moves along the week; each slot shows its run, and the Wednesday run is skipped because the last one was still going.`}
        >
            <div className="relative h-10">
                <div className="absolute top-1/2 right-0 left-0 h-px bg-white/15" />
                {SLOTS.map((slot) => (
                    <div
                        className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/50"
                        key={slot.day}
                        style={{ left: `${slot.at * 100}%` }}
                    />
                ))}
                <motion.div
                    className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_4px_rgba(255,255,255,0.12)]"
                    {...loop([0, 1], { left: ["0%", "100%"], opacity: [1, 1] }, { left: "0%", opacity: 0 }, reduce)}
                />
            </div>
            <div className="grid grid-cols-5 gap-1.5">
                {SLOTS.map((slot) => (
                    <motion.div
                        className="flex flex-col gap-1 rounded-lg border border-white/10 bg-black/40 p-2"
                        key={slot.day}
                        {...fade(slot.at + 0.02, 0.9, reduce)}
                    >
                        <span className="text-[11px] font-medium text-white/80">{slot.day}</span>
                        {slot.skipped ? (
                            <span className="text-[10px] leading-tight text-amber-200/90">{t`Skipped: still running`}</span>
                        ) : (
                            <span className="text-[10px] leading-tight text-emerald-300/90">{t`Passed check`}</span>
                        )}
                    </motion.div>
                ))}
            </div>
        </VisualFrame>
    );
};
