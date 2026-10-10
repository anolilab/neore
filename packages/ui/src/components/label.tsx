"use client";

import cn from "@ui/utils/cn";
import * as React from "react";

const Label = ({ className, ...props }: React.ComponentProps<"label">) => (
    <label
        className={cn(
            "flex items-center gap-2 text-xs/relaxed leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
            className,
        )}
        data-slot="label"
        {...props}
    />
);

export { Label };
