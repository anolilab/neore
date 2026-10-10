"use client";

import VaultGrid from "./grid";
import VaultUploadZone from "./upload-zone";

const VaultView = () => (
    <VaultUploadZone>
        <VaultGrid />
    </VaultUploadZone>
);

export default VaultView;
