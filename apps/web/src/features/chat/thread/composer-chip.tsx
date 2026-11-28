import cn from "@neore/ui/utils/cn";
import type { FC, ReactNode } from "react";

/** One quiet chip. Information, not a control: no button, no hover. The status line and the context row share it. */
const ComposerChip: FC<{ children: ReactNode; className?: string }> = ({ children, className }) => (
    <span
        className={cn("bg-surface-row-active text-muted-foreground inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full px-2 text-xs", className)}
    >
        {children}
    </span>
);

export default ComposerChip;
