"use client";

import { ConsentDialog } from "@c15t/react/components/consent-dialog";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import type { FC } from "react";
import { useState } from "react";

import SettingsCard from "@/components/settings/settings-card";

const ConsentPreferences: FC = () => {
    const { t } = useLingui();
    const [isOpen, setIsOpen] = useState(false);

    return (
        <>
            <SettingsCard description={t`Manage your consent preferences for cookies and data processing`} title={t`Consent Preferences`}>
                <CardContent className="space-y-4">
                    <p className="text-muted-foreground text-sm">
                        {t`You can manage your consent preferences for different types of data processing, including analytics, marketing, and AI features.`}
                    </p>
                    <Button onClick={() => setIsOpen(true)} variant="outline">
                        {t`Manage Consent Preferences`}
                    </Button>
                </CardContent>
            </SettingsCard>
            <ConsentDialog open={isOpen} />
        </>
    );
};

export default ConsentPreferences;
