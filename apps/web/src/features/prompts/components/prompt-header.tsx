"use client";

import { useLingui } from "@lingui/react/macro";

const PromptHeader = () => {
    const { t } = useLingui();

    return (
        <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">{t`Prompts`}</h1>
            <p className="text-muted-foreground">{t`Manage your system prompts for threads. Use them via slash commands or set as default for new threads.`}</p>
        </div>
    );
};

export default PromptHeader;
