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
                                <div className="bg-muted space-y-1 rounded-lg p-4 text-sm">
                                    <p>
                                        <span className="font-medium">{t`Email:`}</span> {dataSummary.profile.email}
                                    </p>
                                    <p>
                                        <span className="font-medium">{t`Name:`}</span> {dataSummary.profile.name || t`Not set`}
                                    </p>
                                    <p>
                                        <span className="font-medium">{t`Account Created:`}</span> {formatDate(dataSummary.profile.createdAt, i18n.locale)}
                                    </p>
                                    <p>
                                        <span className="font-medium">{t`Email Verified:`}</span> {dataSummary.profile.emailVerified ? t`Yes` : t`No`}
                                    </p>
                                </div>
                            </div>
                        )}

                        <div className="space-y-2">
                            <Heading className="text-sm font-medium" fallbackLevel={4}>{t`Data Summary`}</Heading>
                            <div className="bg-muted space-y-1 rounded-lg p-4 text-sm">
                                <p>
                                    <span className="font-medium">{t`Files:`}</span> {dataSummary.dataSummary.files}
                                </p>
                                <p>
                                    <span className="font-medium">{t`Prompts:`}</span> {dataSummary.dataSummary.prompts}
                                </p>
                                <p>
                                    <span className="font-medium">{t`Settings:`}</span>{" "}
                                    {dataSummary.dataSummary.hasSettings ? t`Configured` : t`Not configured`}
                                </p>
                                <p>
                                    <span className="font-medium">{t`GDPR Requests:`}</span> {dataSummary.dataSummary.gdprRequests}
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
