"use client";

import { useSetActiveUI } from "@c15t/react";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import type { FC } from "react";

import SettingsCard from "@/components/settings/settings-card";

const ConsentPreferences: FC = () => {
    const { t } = useLingui();
    // Opens the one `<ConsentDialog />` mounted in `routes/__root.tsx`; a controlled second dialog could not close itself.
    const setActiveUI = useSetActiveUI();

    return (
        <SettingsCard description={t`Manage your consent preferences for cookies and data processing`} title={t`Consent Preferences`}>
            <CardContent className="space-y-4">
                <p className="text-muted-foreground text-sm">
                    {t`You can manage your consent preferences for different types of data processing, including analytics, marketing, and AI features.`}
                </p>
                <Button onClick={() => setActiveUI("dialog")} variant="outline">
                    {t`Manage Consent Preferences`}
                </Button>
            </CardContent>
        </SettingsCard>
    );
};

export default ConsentPreferences;
