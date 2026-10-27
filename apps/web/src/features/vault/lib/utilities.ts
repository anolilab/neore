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
