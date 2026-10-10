"use client";

import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import PrivacySettings from "@/features/settings/components/privacy/privacy-settings";

const PrivacySettingsPage = () => {
    const { t } = useLingui();

    return (
        <div className="container mx-auto max-w-4xl space-y-6 py-8">
            <div>
                {/* The page's h1 is the settings layout's (`SettingsPageOutline`), with this same name: this is only its visible copy. */}
                <p aria-hidden="true" className="text-3xl font-bold">
                    {t`Privacy & Data`}
                </p>
                <p className="text-muted-foreground mt-2">{t`Manage your privacy settings and data rights`}</p>
            </div>
            <PrivacySettings />
        </div>
    );
};

export const Route = createFileRoute("/dashboard/settings/privacy")({
    component: PrivacySettingsPage,
});
