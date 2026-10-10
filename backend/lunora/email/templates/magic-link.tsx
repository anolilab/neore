import { Heading, Link, Text } from "./components/primitives";
import { BaseEmail } from "./components/base-email";
import { styles } from "./components/styles";

interface MagicLinkEmailProperties {
    brandLogoUrl?: string;
    brandName?: string;
    brandTagline?: string;
    url: string;
}

const MagicLinkEmail = ({ brandLogoUrl, brandName, brandTagline, url }: MagicLinkEmailProperties) => (
    <BaseEmail brandLogoUrl={brandLogoUrl} brandName={brandName} brandTagline={brandTagline} previewText="Sign in with this magic link">
        <Heading style={styles.h1}>Sign in</Heading>
        <Link
            href={url}
            style={{
                ...styles.link,
                display: "block",
                marginBottom: "16px",
            }}
            target="_blank"
        >
            Click here to sign in with this magic link
        </Link>
        <Text
            style={{
                ...styles.text,
                color: "#ababab",
                marginBottom: "16px",
                marginTop: "14px",
            }}
        >
            If you didn&apos;t try to sign in, you can safely ignore this email.
        </Text>
    </BaseEmail>
);

export default MagicLinkEmail;
