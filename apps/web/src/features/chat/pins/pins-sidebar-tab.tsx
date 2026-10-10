"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Skeleton } from "@neore/ui/components/skeleton";
import { skipToken, useQuery } from "@tanstack/react-query";
import { PinIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import PinItem from "./pin-item";

interface PinsSidebarTabProps {
    threadId?: string;
}

const PinsSidebarTab: FC<PinsSidebarTabProps> = ({ threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();

    const { data: pins, isLoading } = useQuery(
        crpc.chat.pins.functions.getThreadPins.queryOptions(threadId ? { threadId: threadId as Id<"threads"> } : skipToken),
    );

    if (!threadId) {
        return (
            <motion.div
                animate={{ opacity: 1 }}
                className="text-brand-black/60 dark:text-brand-white/60 border-sidebar-border/50 bg-sidebar-accent/30 flex h-full items-center justify-center rounded-md border p-6 text-center"
                initial={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
            >
                <p className="text-sm">{t`Start a conversation to pin messages.`}</p>
            </motion.div>
        );
    }

    if (isLoading) {
        return (
            <div className="space-y-2 p-1">
                {Array.from({ length: 3 }, (_, i) => (
                    <motion.div
                        animate={{ opacity: 1 }}
                        className="border-border rounded-md border px-3 pt-2.5 pb-2"
                        initial={{ opacity: 0 }}
                        key={i}
                        transition={{ delay: i * 0.05, duration: 0.2 }}
                    >
                        <Skeleton className="bg-brand-cloud mb-1.5 h-3 w-full" />
                        <Skeleton className="bg-brand-cloud mb-3 h-3 w-4/5" />
                        <Skeleton className="bg-brand-cloud mb-3 h-8 w-full" />
                        <div className="flex items-center justify-between">
                            <Skeleton className="bg-brand-cloud h-3 w-12" />
                            <div className="flex gap-1">
                                <Skeleton className="bg-brand-cloud size-5 rounded" />
                                <Skeleton className="bg-brand-cloud size-5 rounded" />
                            </div>
                        </div>
                    </motion.div>
                ))}
            </div>
        );
    }

    if (!pins || pins.length === 0) {
        return (
            <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center justify-center gap-3 p-6 text-center"
                initial={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
            >
                <PinIcon className="text-muted-foreground/50 size-8" />
                <div className="space-y-1">
                    <p className="text-foreground text-sm font-medium">{t`No pins yet`}</p>
                    <p className="text-muted-foreground text-xs">{t`Click the pin icon on any message to save it here.`}</p>
                </div>
            </motion.div>
        );
    }

    return (
        <div className="space-y-2 pr-2 pl-1">
            <AnimatePresence initial={false}>
                {pins.map((pin) => (
                    <motion.div
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
                        initial={{ opacity: 0, y: 8 }}
                        key={pin._id}
                        layout
                        transition={{ duration: 0.2, ease: "easeOut" }}
                    >
                        <PinItem pin={pin} />
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    );
};

export default PinsSidebarTab;
