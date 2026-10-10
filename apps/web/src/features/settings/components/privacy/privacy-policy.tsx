"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import type { FC } from "react";

import SettingsCard from "@/components/settings/settings-card";
import env from "@/lib/env";

const PRIVACY_POLICY_URL = env.VITE_PRIVACY_POLICY_URL || "/privacy-policy";

const PrivacyPolicy: FC = () => {
    const { t } = useLingui();

    return (
        <SettingsCard description={t`Review our privacy policy and data processing practices`} title={t`Privacy Policy`}>
            <CardContent className="space-y-4">
                <p className="text-muted-foreground text-sm">
                    {t`Our privacy policy explains how we collect, use, and protect your personal data in accordance with GDPR and other applicable data protection laws.`}
                </p>
                <a className="text-primary text-sm font-medium hover:underline" href={PRIVACY_POLICY_URL} rel="noopener noreferrer" target="_blank">
                    {t`View Privacy Policy`} →
                </a>
            </CardContent>
        </SettingsCard>
    );
};

export default PrivacyPolicy;
