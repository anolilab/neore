import { useLingui } from "@lingui/react/macro";
import { motion } from "motion/react";

import { fade, useReduce } from "./timeline";
import { VisualFrame } from "./visual-frame";

export const MemoryVisual = () => {
    const { t } = useLingui();
    const reduce = useReduce();

    return (
        <VisualFrame
            label={t`Memory. A new preference is saved as a memory, then a later question uses two saved memories, which are listed as memories used.`}
        >
            <div className="flex flex-col gap-2">
                <span className="text-[11px] font-medium text-white/40 uppercase">{t`Saved memories`}</span>
                <div className="flex flex-wrap gap-2">
                    <span className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-white/80">{t`Prefers metric units`}</span>
                    <span className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-white/80">{t`Working on a mobile app`}</span>
                    <motion.span
                        className="flex items-center gap-2 rounded-full border border-emerald-300/40 bg-emerald-300/10 px-2.5 py-1 text-xs text-emerald-100"
                        {...fade(0.14, 0.9, reduce)}
                    >
                        {t`Prefers short answers`}
                        <span className="rounded bg-emerald-300/20 px-1 text-[10px] uppercase">{t`Saved`}</span>
                    </motion.span>
                </div>
            </div>

            <motion.div className="max-w-[85%] self-end rounded-2xl rounded-tr-sm bg-white/10 px-3 py-2 text-sm text-white" {...fade(0.46, 0.94, reduce)}>
                {t`Plan my week`}
            </motion.div>

            <motion.div className="flex flex-col gap-2 self-start rounded-xl border border-white/10 bg-black/40 p-3" {...fade(0.62, 0.94, reduce)}>
                <span className="text-[11px] font-medium text-white/60">{t`Memories used (2)`}</span>
                <div className="flex flex-wrap gap-2">
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/80">{t`Prefers metric units`}</span>
                    <span className="rounded-full bg-emerald-300/10 px-2 py-0.5 text-[11px] text-emerald-100">{t`Prefers short answers`}</span>
                </div>
            </motion.div>
        </VisualFrame>
    );
};
