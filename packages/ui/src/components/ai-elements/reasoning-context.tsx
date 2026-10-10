"use client";

import { createContext } from "react";

interface ReasoningContextValue {
    duration: number | undefined;
    isOpen: boolean;
    isStreaming: boolean;
    setIsOpen: (open: boolean) => void;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export { ReasoningContext, type ReasoningContextValue };
