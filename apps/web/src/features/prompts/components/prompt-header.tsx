"use client";

import { useLingui } from "@lingui/react/macro";

const PromptHeader = () => {
    const { t } = useLingui();

    return (
        <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">{t`Prompts`}</h1>
            <p className="text-muted-foreground max-w-3xl text-sm text-pretty">{t`Manage your system prompts for threads. Use them via slash commands or set as default for new threads.`}</p>
        </div>
    );
};

export default PromptHeader;
