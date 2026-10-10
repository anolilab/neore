import { Avatar, AvatarFallback } from "@neore/ui/components/avatar";
import type { FC } from "react";

import cn from "../utils/cn";

/** A group-chat participant's avatar — a face generated from its name, so each speaker is recognisable at a glance. */
export const SpeakerAvatar: FC<{ className?: string; name: string; size?: "default" | "sm" }> = ({ className, name, size = "sm" }) => (
    <Avatar aria-hidden="true" className={className} size={size}>
        <AvatarFallback name={name} />
    </Avatar>
);

/** Name chip: avatar and name. The name is real text, so screen readers read who is speaking. */
export const SpeakerChip: FC<{ className?: string; name: string }> = ({ className, name }) => (
    <span className={cn("text-foreground inline-flex items-center gap-1.5 text-sm font-medium dark:text-white", className)}>
        <SpeakerAvatar name={name} />
        <span className="truncate">{name}</span>
    </span>
);

export default SpeakerChip;
