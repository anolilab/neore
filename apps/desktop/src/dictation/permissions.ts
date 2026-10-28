/**
 * One permission policy for every session the shell creates: the default session (the site and the other local
 * windows) and the dictation window's own. Electron grants every permission unless told otherwise, so each handler
 * answers from here.
 *
 * - A site page gets what `sitePermissions` lists, on its trusted origin.
 * - The dictation window gets the microphone and nothing else: `media` for audio only, asked by that window's own
 * contents, on its own page. For a `file:` page the "origin" Electron passes to the check handler is just `file:///`, so the
 * page is identified by the contents and the request URL together.
 * - Everything else (another local window, a foreign origin, an artifact preview) is refused.
 */
export interface PermissionPolicyOptions {
    /** Is this the live dictation window's own contents, asking from its own page? */
    isDictationWindow: (webContents: unknown, url: string | undefined) => boolean;
    /** Is this a page of the site, on its trusted origin? */
    isSiteUrl: (url: string | undefined) => boolean;
    sitePermissions: ReadonlySet<string>;
}

interface RequestDetails {
    mediaTypes?: ReadonlyArray<string>;
    requestingUrl: string;
}

interface CheckDetails {
    mediaType?: string;
    requestingUrl?: string;
}

export interface PermissionPolicy {
    check: (webContents: unknown, permission: string, requestingOrigin: string, details?: CheckDetails) => boolean;
    request: (webContents: unknown, permission: string, callback: (isAllowed: boolean) => void, details: RequestDetails) => void;
}

export const createPermissionPolicy = (options: PermissionPolicyOptions): PermissionPolicy => {
    const decide = (webContents: unknown, permission: string, url: string | undefined, audioOnly: boolean): boolean => {
        if (permission === "media" && options.isDictationWindow(webContents, url)) {
            return audioOnly;
        }

        return options.sitePermissions.has(permission) && options.isSiteUrl(url);
    };

    return {
        check: (webContents, permission, requestingOrigin, details) =>
            // Chromium asks the check first without saying what kind of media it means; the request that follows does say, and only
            // an audio-only one is granted. A check that names video (or anything but audio) is refused here too.
            decide(webContents, permission, details?.requestingUrl ?? requestingOrigin, details?.mediaType === undefined || details.mediaType === "audio"),
        request: (webContents, permission, callback, details) => {
            const types = details.mediaTypes;

            callback(decide(webContents, permission, details.requestingUrl, types?.length === 1 && types[0] === "audio"));
        },
    };
};

/**
 * The dictation window has no network: a request is allowed only if it loads one of the window's own files.
 * `folder` is the file URL of the folder those files are in, with a trailing slash.
 */
export const isDictationAsset = (folder: string, rawUrl: string): boolean => {
    const url = URL.parse(rawUrl);

    return url !== null && url.protocol === "file:" && url.href.startsWith(folder) && !url.pathname.includes("..");
};
