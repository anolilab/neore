import { useLingui } from "@lingui/react/macro";
import { motion } from "motion/react";

import { fade, loop, useReduce } from "./timeline";
import { VisualFrame } from "./visual-frame";

const PLATFORMS = ["Telegram", "WhatsApp", "Slack", "Discord"] as const;

export const MessagingVisual = () => {
    const { t } = useLingui();
    const reduce = useReduce();

    return (
        <VisualFrame label={t`A message arrives from a chat app, a dot travels down to the agent, and the reply appears in the same chat.`}>
            <div className="flex flex-wrap gap-2">
                {PLATFORMS.map((platform) => (
                    <span className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-white/70" key={platform}>
                        {platform}
                    </span>
                ))}
            </div>

            <motion.div className="max-w-[85%] self-start rounded-2xl rounded-tl-sm bg-white/10 px-3 py-2 text-sm text-white" {...fade(0.06, 0.9, reduce)}>
                {t`Summarise my notes from today`}
            </motion.div>

            <div className="relative mx-auto h-10 w-px bg-white/15">
                <motion.span
                    className="absolute left-1/2 size-2 -translate-x-1/2 rounded-full bg-white"
                    {...loop(
                        [0, 0.2, 0.24, 0.44, 0.48, 1],
                        { top: ["0%", "0%", "0%", "100%", "100%", "100%"], opacity: [0, 0, 1, 1, 0, 0] },
                        { top: "100%", opacity: 0 },
                        reduce,
                    )}
                />
            </div>

            <div className="mx-auto rounded-full bg-white px-3 py-1 text-xs font-medium text-black">{t`Neore agent`}</div>

            <motion.div className="max-w-[85%] self-end rounded-2xl rounded-tr-sm bg-white/10 px-3 py-2 text-sm text-white" {...fade(0.5, 0.9, reduce)}>
                {t`Here is a summary, with the open items first.`}
            </motion.div>
        </VisualFrame>
    );
};
