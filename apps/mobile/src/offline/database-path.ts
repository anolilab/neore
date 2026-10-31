const FILE_SCHEME = /^file:\/\//;

/**
 * The folder for the cache file, from the cache directory's `file://` URI. That directory is outside what iOS puts
 * in an iCloud or device backup and what Android Auto Backup copies, so the saved chats never leave the phone
 * through a backup. The OS may clear it; the cache is only a copy and is filled again by the next read.
 */
export const databaseDirectory = (cacheDirectoryUri: string): string => {
    const path = decodeURI(cacheDirectoryUri.replace(FILE_SCHEME, ""));

    return path.endsWith("/") ? path.slice(0, -1) : path;
};
