"use client";

import { useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

import { GetStarted } from "./empty-states";
import VaultItem from "./item";

const VaultGrid = () => {
    const crpc = useCRPC();
    // Query files for the current user
    const { data: files = [] } = useQuery(crpc.vault.functions.getAttachmentsForUser.queryOptions({}));

    // Show empty state if no files
    if (!files?.length) {
        return <GetStarted />;
    }

    return (
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {files.map((file) => (
                <VaultItem data={file} key={file._id} />
            ))}
        </div>
    );
};

export default VaultGrid;
