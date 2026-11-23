/**
 * The account of a page whose session has loaded with no user (a guest), so a sign-in during a waiting send reads as an
 * account change. A drop made then is never taken by a signed-in
 * account's composer (`composer-submit.ts`); an absent account means only "the session is still loading". Its own
 * module, so the root's native bridge can use it without loading the composer channels.
 */
export const SIGNED_OUT = "signed-out";
