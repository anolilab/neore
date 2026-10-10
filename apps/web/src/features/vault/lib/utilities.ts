export const formatFileSize = (bytes: number): string => {
    if (bytes === 0) {
        return "0 Bytes";
    }

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const index = Math.floor(Math.log(bytes) / Math.log(k));

    return `${Number((bytes / k ** index).toFixed(2))} ${sizes[index]}`;
};

export const getFileIcon = (fileType: string) => {
    if (fileType.startsWith("image/")) {
        return "🖼️";
    }

    if (fileType.startsWith("video/")) {
        return "🎥";
    }

    if (fileType.startsWith("audio/")) {
        return "🎵";
    }

    if (fileType === "application/pdf") {
        return "📄";
    }

    if (fileType.includes("document") || fileType.includes("word")) {
        return "📝";
    }

    if (fileType.includes("spreadsheet") || fileType.includes("excel")) {
        return "📊";
    }

    if (fileType.includes("presentation") || fileType.includes("powerpoint")) {
        return "📽️";
    }

    return "📄";
};
