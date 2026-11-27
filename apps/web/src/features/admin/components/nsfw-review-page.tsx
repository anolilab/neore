"use client";

import { useLingui } from "@lingui/react/macro";
import { ShieldAlert } from "lucide-react";

import { AdminBlock, AdminSection } from "./admin-section";

const NsfwReviewPage = () => {
    const { t } = useLingui();

    return (
        <div className="flex flex-col gap-6">
            <AdminSection
                description={t`Review and moderate flagged content across chat and vault.`}
                title={
                    <span className="flex items-center gap-2">
                        <ShieldAlert aria-hidden="true" className="size-4" />
                        {t`NSFW Content Review`}
                    </span>
                }
            >
                <AdminBlock>
                    <p className="text-muted-foreground text-sm">{t`NSFW review backend is not yet implemented. This page will display flagged images for moderation once the backend functions are available.`}</p>
                </AdminBlock>
            </AdminSection>
        </div>
    );
};

export default NsfwReviewPage;
