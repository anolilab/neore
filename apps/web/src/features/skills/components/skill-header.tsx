"use client";

import { useLingui } from "@lingui/react/macro";

const SkillHeader = () => {
    const { t } = useLingui();

    return (
        <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">{t`Skills`}</h1>
            <p className="text-muted-foreground">{t`Manage your automation skills. Create custom workflows, import from GitHub, or install from the official catalog. Use them via slash commands.`}</p>
        </div>
    );
};

export default SkillHeader;
