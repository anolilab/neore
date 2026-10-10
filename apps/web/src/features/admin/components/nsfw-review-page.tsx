"use client";

import { useLingui } from "@lingui/react/macro";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { ShieldAlert } from "lucide-react";

const NsfwReviewPage = () => {
    const { t } = useLingui();

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <ShieldAlert className="size-5" />
                        {t`NSFW Content Review`}
                    </CardTitle>
                    <CardDescription>{t`Review and moderate flagged content across chat and vault.`}</CardDescription>
                </CardHeader>
                <CardContent>
                    <p className="text-muted-foreground text-sm">{t`NSFW review backend is not yet implemented. This page will display flagged images for moderation once the backend functions are available.`}</p>
                </CardContent>
            </Card>
        </div>
    );
};

export default NsfwReviewPage;
