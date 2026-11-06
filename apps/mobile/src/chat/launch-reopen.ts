/** The launch's reopen claim: the first screen to ask for it decides, so a chat opened from a link is not followed by the saved one. */
const launch = { isClaimed: false };

/** True for the first caller of this launch only. */
export const canClaimLaunchReopen = (): boolean => {
    if (launch.isClaimed) {
        return false;
    }

    launch.isClaimed = true;

    return true;
};
