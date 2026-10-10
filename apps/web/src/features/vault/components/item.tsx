"use client";

import cn from "@neore/ui/utils/cn";
import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo } from "lucide-react";

import { formatFileSize } from "../lib/utilities";
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
            return <FileImage className="h-6 w-6 text-blue-600 dark:text-blue-400" />;
        }

        if (fileType.startsWith("video/")) {
            return <FileVideo className="h-6 w-6 text-red-600 dark:text-red-400" />;
        }

        if (fileType.startsWith("audio/")) {
            return <FileAudio className="h-6 w-6 text-green-600 dark:text-green-400" />;
        }

        if (fileType === "application/pdf") {
            return <FileText className="h-6 w-6 text-red-600 dark:text-red-400" />;
        }

        if (fileType.includes("zip") || fileType.includes("rar")) {
            return <FileArchive className="h-6 w-6 text-yellow-600 dark:text-yellow-400" />;
        }

        return <File className="h-6 w-6 text-gray-600 dark:text-gray-400" />;
    };

    return (
        <div
            className={cn(
                "text-muted-foreground hover:bg-muted group relative flex h-72 flex-col gap-3 border p-4 transition-colors duration-200 dark:hover:bg-[#141414]",
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
                    <div className="rounded-lg bg-gray-100 p-2 dark:bg-gray-800">{getFileIcon(data.fileType)}</div>
                )}
            </div>

            <div className="mt-auto flex flex-col gap-1">
                <h2 className="text-primary line-clamp-1 text-sm">{data.fileName}</h2>
                <p className="text-muted-foreground text-xs">{formatFileSize(data.fileSize)}</p>
            </div>
        </div>
    );
};

export default VaultItem;
