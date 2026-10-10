import { forgetFeishuTokens } from "../platforms/feishu";
import { forgetTeamsTokens } from "../platforms/teams";
import { forgetWeChatTokens } from "../platforms/wechat";

/**
 * Drop every access token this isolate derived from a user's messenger
 * credentials (Feishu tenant tokens, Bot Framework connector tokens, WeChat
 * access tokens). Used by account deletion; other isolates' caches expire on
 * their own within two hours. `keys` is the decrypted `messengerKeys` record.
 */
export const forgetMessengerCredentials = (keys: Record<string, string | undefined>): void => {
    if (keys.feishu_app_id) {
        forgetFeishuTokens(keys.feishu_app_id);
    }

    if (keys.teams_app_id) {
        forgetTeamsTokens(keys.teams_app_id);
    }

    if (keys.wechat_app_id) {
        forgetWeChatTokens(keys.wechat_app_id);
    }
};
