"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import type { FC } from "react";

import SettingsCard from "@/components/settings/settings-card";
import env from "@/lib/env";

const DPO_EMAIL = env.VITE_DPO_EMAIL || "dpo@example.com";

const DpoContact: FC = () => {
    const { t } = useLingui();
    const dpoName = env.VITE_DPO_NAME || t`Data Protection Officer`;

    return (
        <SettingsCard description={t`Contact our Data Protection Officer for questions about your data rights`} title={t`Data Protection Officer`}>
            <CardContent className="space-y-4">
                <div className="space-y-2">
                    <p className="font-medium">{dpoName}</p>
                    <p className="text-muted-foreground text-sm">
                        {t`Email:`}{" "}
                        <a className="text-primary hover:underline" href={`mailto:${DPO_EMAIL}`}>
                            {DPO_EMAIL}
                        </a>
                    </p>
                </div>
                <p className="text-muted-foreground text-xs">
                    {t`You can contact our Data Protection Officer for any questions regarding your personal data, GDPR rights, or privacy concerns.`}
                </p>
            </CardContent>
        </SettingsCard>
    );
};

export default DpoContact;
