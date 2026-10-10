"use client";

/**
 * ThreadModeSkeleton - Loading skeleton shown while thread mode is being determined
 *
 * This prevents a flash of wrong content when loading an existing thread
 * that might be in image/video mode.
 */

import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";

interface ThreadModeSkeletonProps {
    className?: string;
    maxWidth?: string;
}

const ThreadModeSkeleton: FC<ThreadModeSkeletonProps> = ({ className, maxWidth = "65ch" }) => (
    <div className={cn("flex h-full flex-col items-center bg-inherit px-4 pt-8", className)} style={{ "--thread-max-width": maxWidth } as React.CSSProperties}>
        <div className="flex min-h-full w-full max-w-(--thread-max-width) flex-col">
            {/* Message skeleton */}
            <div className="flex-1 space-y-6 py-4">
                {/* User message skeleton */}
                <div className="flex justify-end">
                    <Skeleton className="h-12 w-3/4 rounded-lg" />
                </div>
                {/* Assistant message skeleton */}
                <div className="flex justify-start">
                    <div className="space-y-2">
                        <Skeleton className="h-4 w-64" />
                        <Skeleton className="h-4 w-80" />
                        <Skeleton className="h-4 w-56" />
                    </div>
                </div>
            </div>

            {/* Composer skeleton */}
            <div className="sticky bottom-0 flex w-full flex-col items-center justify-end rounded-t-lg bg-inherit pb-4">
                <Skeleton className="h-24 w-full rounded-lg" />
            </div>
        </div>
    </div>
);

ThreadModeSkeleton.displayName = "ThreadModeSkeleton";

export default ThreadModeSkeleton;
