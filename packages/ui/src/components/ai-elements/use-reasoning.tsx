"use client";

import { use } from "react";

import { ReasoningContext } from "./reasoning-context";

const useReasoning = () => {
    const context = use(ReasoningContext);

    if (!context) {
        throw new Error("Reasoning components must be used within Reasoning");
    }

    return context;
};

export { useReasoning };
