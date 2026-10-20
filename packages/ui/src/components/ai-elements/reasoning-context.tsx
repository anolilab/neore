"use client";

import { createContext } from "react";

interface ReasoningContextValue {
    duration: number | undefined;
    isOpen: boolean;
    isStreaming: boolean;
    setIsOpen: (open: boolean) => void;
    /** Id of the trigger button, so a control below the content can hand focus back to it. */
    triggerId: string;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export { ReasoningContext, type ReasoningContextValue };
