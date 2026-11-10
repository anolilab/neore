import { useLingui } from "@lingui/react/macro";
import { motion } from "motion/react";

import { fade, useReduce } from "./timeline";
import { VisualFrame } from "./visual-frame";

export const GroupChatsVisual = () => {
    const { t } = useLingui();
    const reduce = useReduce();

    return (
        <VisualFrame
            label={t`A group chat. A question from the owner is answered by three agents in turn: a security reviewer, a performance reviewer, and a lead who sums up.`}
        >
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-white/50">
                <span>{t`Code review panel`}</span>
                <span>{t`Parallel replies`}</span>
            </div>

            <motion.div className="max-w-[85%] self-end rounded-2xl rounded-tr-sm bg-white/15 px-3 py-2 text-sm text-white" {...fade(0.04, 0.94, reduce)}>
                {t`Is this change safe to ship?`}
            </motion.div>

            <motion.div className="flex max-w-[90%] flex-col gap-1 self-start" {...fade(0.14, 0.94, reduce)}>
                <span className="text-[11px] font-medium text-sky-200">{t`Security Reviewer`}</span>
                <span className="rounded-2xl rounded-tl-sm bg-white/10 px-3 py-2 text-sm text-white/90">{t`No new secrets. The upload path still needs a size check.`}</span>
            </motion.div>

            <motion.div className="flex max-w-[90%] flex-col gap-1 self-start" {...fade(0.4, 0.94, reduce)}>
                <span className="text-[11px] font-medium text-emerald-200">{t`Performance Reviewer`}</span>
                <span className="rounded-2xl rounded-tl-sm bg-white/10 px-3 py-2 text-sm text-white/90">{t`The new query is indexed. No extra round trip.`}</span>
            </motion.div>

            <motion.div className="flex max-w-[90%] flex-col gap-1 self-start" {...fade(0.66, 0.94, reduce)}>
                <span className="text-[11px] font-medium text-amber-200">{t`Review Lead`}</span>
                <span className="rounded-2xl rounded-tl-sm bg-white/10 px-3 py-2 text-sm text-white/90">{t`Ship after the size check is added.`}</span>
            </motion.div>
        </VisualFrame>
    );
};
