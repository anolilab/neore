import type { ProviderIcon } from "../components/provider-icons";
import {
    AppleIcon,
    DiscordIcon,
    DropboxIcon,
    FacebookIcon,
    GitHubIcon,
    GitLabIcon,
    GoogleIcon,
    KickIcon,
    LinkedInIcon,
    MicrosoftIcon,
    RedditIcon,
    RobloxIcon,
    SpotifyIcon,
    TikTokIcon,
    TwitchIcon,
    VKIcon,
    XIcon,
    ZoomIcon,
} from "../components/provider-icons";

const socialProviders = [
    {
        icon: AppleIcon,
        name: "Apple",
        provider: "apple",
    },
    {
        icon: DiscordIcon,
        name: "Discord",
        provider: "discord",
    },
    {
        icon: DropboxIcon,
        name: "Dropbox",
        provider: "dropbox",
    },
    {
        icon: FacebookIcon,
        name: "Facebook",
        provider: "facebook",
    },
    {
        icon: GitHubIcon,
        name: "GitHub",
        provider: "github",
    },
    {
        icon: GitLabIcon,
        name: "GitLab",
        provider: "gitlab",
    },
    {
        icon: GoogleIcon,
        name: "Google",
        provider: "google",
    },
    {
        icon: KickIcon,
        name: "Kick",
        provider: "kick",
    },
    {
        icon: LinkedInIcon,
        name: "LinkedIn",
        provider: "linkedin",
    },
    {
        icon: MicrosoftIcon,
        name: "Microsoft",
        provider: "microsoft",
    },
    {
        icon: RedditIcon,
        name: "Reddit",
        provider: "reddit",
    },
    {
        icon: RobloxIcon,
        name: "Roblox",
        provider: "roblox",
    },
    {
        icon: SpotifyIcon,
        name: "Spotify",
        provider: "spotify",
    },
    {
        icon: TikTokIcon,
        name: "TikTok",
        provider: "tiktok",
    },
    {
        icon: TwitchIcon,
        name: "Twitch",
        provider: "twitch",
    },
    {
        icon: VKIcon,
        name: "VK",
        provider: "vk",
    },
    {
        icon: XIcon,
        name: "X",
        provider: "twitter",
    },
    {
        icon: ZoomIcon,
        name: "Zoom",
        provider: "zoom",
    },
] as const;

export type Provider = {
    icon?: ProviderIcon;
    name: string;
    provider: string;
};

export default socialProviders;
