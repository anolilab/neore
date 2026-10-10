"use client";

import { useQuery } from "@tanstack/react-query";
import type { FC } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import DataImport from "./chat-import/data-import";
import ConsentPreferences from "./consent-preferences";
import DataAccess from "./data-access";
import DataExport from "./data-export";
import DpoContact from "./dpo-contact";
import PrivacyPolicy from "./privacy-policy";

const PrivacySettings: FC = () => {
    const crpc = useCRPC();
    // Use combined query to reduce database lookups (1 session lookup instead of 2)
    const { data: gdprStatus } = useQuery(crpc.gdpr.functions.getGdprStatus.queryOptions({}));

    return (
        <div className="space-y-6">
            <PrivacyPolicy />
            <ConsentPreferences />
            <DataAccess />
            <DataImport />
            <DataExport exportStatus={gdprStatus?.export} isLoading={gdprStatus === undefined} />
            <DpoContact />
        </div>
    );
};

export default PrivacySettings;
