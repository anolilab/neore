"use client";

import { useLingui } from "@lingui/react/macro";

import UploadButton from "./upload-button";

const VaultHeader = () => {
    const { t } = useLingui();

    return (
        <div className="flex items-center justify-between gap-4">
            <h1 className="text-xl font-semibold tracking-tight">{t`Vault`}</h1>
            <UploadButton />
        </div>
    );
};

export default VaultHeader;
