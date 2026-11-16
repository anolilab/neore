/**
 * The iOS Notification Service Extension (`@bacons/apple-targets`): rewrites a push's
 * placeholder alert with the real text fetched from our backend before it shows.
 * It reads the session grant from the app's own keychain group (`app.config.ts`).
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = function notificationServiceTarget() {
    return {
        deploymentTarget: "15.1",
        entitlements: { "keychain-access-groups": ["$(AppIdentifierPrefix)ai.neore.mobile"] },
        type: "notification-service",
    };
};
