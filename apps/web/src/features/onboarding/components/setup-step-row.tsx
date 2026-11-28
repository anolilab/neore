import { Check } from "lucide-react";
import type { FC, ReactNode } from "react";

interface SetupStepRowProps {
    /** The step's own controls: its link and Skip / Resume. */
    children?: ReactNode;
    description: string;
    done?: boolean;
    /** A save that was refused: the message stays beside the step after the toast has gone. */
    error?: string;
    /** Shown after the title, in brackets: "Done", "To do", "Checking". */
    statusLabel: string;
    title: string;
}

/** One row of the coding setup list: title and state, a short description, then the step's controls. */
const SetupStepRow: FC<SetupStepRowProps> = ({ children, description, done = false, error, statusLabel, title }) => (
    <li className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-56">
            <p className="text-sm font-medium">
                {done && <Check aria-hidden="true" className="mr-1 inline size-4" />}
                {title} <span className="text-muted-foreground font-normal">({statusLabel})</span>
            </p>
            <p className="text-muted-foreground text-xs">{description}</p>
            {error !== undefined && <p className="text-destructive mt-1 text-xs">{error}</p>}
        </div>
        {children}
    </li>
);

export default SetupStepRow;
