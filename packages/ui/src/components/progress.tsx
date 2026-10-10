"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import cn from "@ui/utils/cn";

const Progress = ({ children, className, ...props }: ProgressPrimitive.Root.Props) => (
    <ProgressPrimitive.Root className={cn("flex w-full flex-col gap-2", className)} data-slot="progress" {...props}>
        {children || (
            <ProgressTrack>
                <ProgressIndicator />
            </ProgressTrack>
        )}
    </ProgressPrimitive.Root>
);

const ProgressLabel = ({ className, ...props }: ProgressPrimitive.Label.Props) => (
    <ProgressPrimitive.Label className={cn("text-sm font-medium", className)} data-slot="progress-label" {...props} />
);

const ProgressTrack = ({ className, ...props }: ProgressPrimitive.Track.Props) => (
    <ProgressPrimitive.Track className={cn("bg-input block h-1.5 w-full overflow-hidden rounded-full", className)} data-slot="progress-track" {...props} />
);

const ProgressIndicator = ({ className, ...props }: ProgressPrimitive.Indicator.Props) => (
    <ProgressPrimitive.Indicator className={cn("bg-primary transition-all duration-500", className)} data-slot="progress-indicator" {...props} />
);

const ProgressValue = ({ className, ...props }: ProgressPrimitive.Value.Props) => (
    <ProgressPrimitive.Value className={cn("text-sm tabular-nums", className)} data-slot="progress-value" {...props} />
);

export { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue };
