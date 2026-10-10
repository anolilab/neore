"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Upload } from "lucide-react";

const UploadButton = () => {
    const { t } = useLingui();

    return (
        <Button aria-label={t`Upload`} onClick={() => document.querySelector<HTMLInputElement>("#upload-files")?.click()} size="icon" variant="outline">
            <Upload aria-hidden="true" size={17} />
        </Button>
    );
};

export default UploadButton;
