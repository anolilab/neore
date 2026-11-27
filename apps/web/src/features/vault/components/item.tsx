"use client";

import { formatFileSize } from "@neore/ui/components/file-renderers/file-type-utilities";
import cn from "@neore/ui/utils/cn";
import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo } from "lucide-react";

import ItemActions from "./item-actions";

type FileItem = {
    _creationTime: number;
    _id: string;
    chatId?: string;
    fileName: string;
    fileSize: number;
    fileType: string;
    isGenerated?: boolean;
    key?: string;
    url?: string;
};

type Properties = {
    data: FileItem;
    small?: boolean;
};

const VaultItem = ({ data, small }: Properties) => {
    const getFileIcon = (fileType: string) => {
        if (fileType.startsWith("image/")) {
            return <FileImage className="h-6 w-6" />;
        }

        if (fileType.startsWith("video/")) {
            return <FileVideo className="h-6 w-6" />;
        }

        if (fileType.startsWith("audio/")) {
            return <FileAudio className="h-6 w-6" />;
        }

        if (fileType === "application/pdf") {
            return <FileText className="h-6 w-6" />;
        }

        if (fileType.includes("zip") || fileType.includes("rar")) {
            return <FileArchive className="h-6 w-6" />;
        }

        return <File className="h-6 w-6" />;
    };

    return (
        <div
            className={cn(
                "text-muted-foreground surface-raised hover:bg-muted/50 group relative flex h-72 flex-col gap-3 rounded-xl p-4 transition-colors duration-200",
                small && "h-48",
            )}
        >
            <div className="absolute top-4 right-4 opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100">
                <ItemActions fileName={data.fileName} fileType={data.fileType} id={data._id} />
            </div>

            <div className="flex h-full w-full items-center justify-center">
                {data.fileType.startsWith("image/") && data.url ? (
                    <img alt={data.fileName} className="max-h-full max-w-full rounded-lg object-cover" src={data.url} />
                ) : (
                    <div aria-hidden="true" className="surface-well rounded-lg p-3">
                        {getFileIcon(data.fileType)}
                    </div>
                )}
            </div>

            <div className="mt-auto flex flex-col gap-1">
                <h2 className="text-foreground line-clamp-1 text-sm font-medium">{data.fileName}</h2>
                <p className="text-muted-foreground text-xs">{formatFileSize(data.fileSize)}</p>
            </div>
        </div>
    );
};

export default VaultItem;
