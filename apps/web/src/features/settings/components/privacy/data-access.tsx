"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { Heading } from "@neore/ui/components/heading";
import { formatDate } from "@neore/ui/utils/locale-format";
import { useQuery } from "@tanstack/react-query";
import type { FC } from "react";

import SettingsCard from "@/components/settings/settings-card";
import { useCRPC } from "@/lib/lunora/crpc";

const DataAccess: FC = () => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const { data: dataSummary } = useQuery(crpc.gdpr.functions.getDataAccessSummary.queryOptions({}));

    return (
        <SettingsCard
            description={t`View a summary of the personal data we process about you (GDPR Article 15 - Right of Access)`}
            title={t`Data Access Summary`}
        >
            <CardContent className="space-y-4">
                {dataSummary === undefined ? (
                    <p className="text-muted-foreground text-sm">{t`Loading...`}</p>
                ) : (
                    <>
                        {dataSummary.profile && (
                            <div className="space-y-2">
                                <Heading className="text-sm font-medium" fallbackLevel={4}>{t`Profile Information`}</Heading>
                                <div className="divide-border/50 divide-y text-sm">
                                    <p className="flex justify-between gap-4 py-2">
                                        <span className="text-muted-foreground">{t`Email:`}</span> {dataSummary.profile.email}
                                    </p>
                                    <p className="flex justify-between gap-4 py-2">
                                        <span className="text-muted-foreground">{t`Name:`}</span> {dataSummary.profile.name || t`Not set`}
                                    </p>
                                    <p className="flex justify-between gap-4 py-2">
                                        <span className="text-muted-foreground">{t`Account Created:`}</span>{" "}
                                        {formatDate(dataSummary.profile.createdAt, i18n.locale)}
                                    </p>
                                    <p className="flex justify-between gap-4 py-2">
                                        <span className="text-muted-foreground">{t`Email Verified:`}</span> {dataSummary.profile.emailVerified ? t`Yes` : t`No`}
                                    </p>
                                </div>
                            </div>
                        )}

                        <div className="space-y-2">
                            <Heading className="text-sm font-medium" fallbackLevel={4}>{t`Data Summary`}</Heading>
                            <div className="divide-border/50 divide-y text-sm">
                                <p className="flex justify-between gap-4 py-2">
                                    <span className="text-muted-foreground">{t`Files:`}</span> {dataSummary.dataSummary.files}
                                </p>
                                <p className="flex justify-between gap-4 py-2">
                                    <span className="text-muted-foreground">{t`Prompts:`}</span> {dataSummary.dataSummary.prompts}
                                </p>
                                <p className="flex justify-between gap-4 py-2">
                                    <span className="text-muted-foreground">{t`Settings:`}</span>{" "}
                                    {dataSummary.dataSummary.hasSettings ? t`Configured` : t`Not configured`}
                                </p>
                                <p className="flex justify-between gap-4 py-2">
                                    <span className="text-muted-foreground">{t`GDPR Requests:`}</span> {dataSummary.dataSummary.gdprRequests}
                                </p>
                            </div>
                        </div>

                        <p className="text-muted-foreground text-xs">
                            {t`For detailed information including conversations and messages, please use the Data Export feature.`}
                        </p>
                    </>
                )}
            </CardContent>
        </SettingsCard>
    );
};

export default DataAccess;
