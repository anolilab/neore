"use client";

import { Trans } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { FileX } from "lucide-react";

export const NoResults = () => (
    <div className="flex h-screen w-full flex-col items-center justify-center">
        <div className="-mt-[160px] flex flex-col items-center">
            <FileX className="text-muted-foreground mb-4 h-12 w-12" />
            <div className="mb-6 space-y-2 text-center">
                <h2 className="text-lg font-medium">
                    <Trans>No results</Trans>
                </h2>
                <p className="text-sm text-[#606060]">
                    <Trans>Try another search term</Trans>
                </p>
            </div>

            <Button onClick={() => {}} variant="outline">
                <Trans>Clear search</Trans>
            </Button>
        </div>
    </div>
);

export const GetStarted = () => (
    <div className="flex h-[calc(100vh-250px)] items-center justify-center">
        <div className="relative z-20 m-auto flex w-full max-w-[380px] flex-col">
            <div className="relative flex w-full flex-col text-center">
                <div className="pb-4">
                    <h2 className="text-lg font-medium">
                        <Trans>Always find what you need</Trans>
                    </h2>
                </div>

                <p className="pb-6 text-sm text-[#878787]">
                    <Trans>
                        Drag & drop or upload your documents. We&apos;ll automatically organize them with tags based on content, making them easy and secure to
                        find.
                    </Trans>
                </p>

                <Button onClick={() => document.querySelector<HTMLInputElement>("#upload-files")?.click()} variant="outline">
                    <Trans>Upload</Trans>
                </Button>
            </div>
        </div>
    </div>
);
