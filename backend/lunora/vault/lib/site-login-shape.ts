/**
 * `data.code` of the `CONFLICT` a save of a saved login gets when the login changed after the form opened it: the save
 * carried an older `expectedUpdatedAt`. The web form reloads the login on it.
 */
export const SITE_LOGIN_CHANGED = "SITE_LOGIN_CHANGED";

/**
 * `data.code` of the `BAD_REQUEST` a save gets when its sign-in page is no https:// page of the login's own site: another
 * origin, a subdomain, another port, credentials in it, or no URL at all. The web form names the rule on it.
 */
export const SITE_LOGIN_SIGN_IN_PAGE_REFUSED = "SITE_LOGIN_SIGN_IN_PAGE_REFUSED";

/** Longest sign-in page address a login keeps. */
export const SIGN_IN_URL_MAX = 2048;
