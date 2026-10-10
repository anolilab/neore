import { Heading, Link, Text } from "./components/primitives";
import { BaseEmail } from "./components/base-email";
import { styles } from "./components/styles";

interface ResetPasswordEmailProperties {
    brandLogoUrl?: string;
    brandName?: string;
    brandTagline?: string;
    url: string;
}

const ResetPasswordEmail = ({ brandLogoUrl, brandName, brandTagline, url }: ResetPasswordEmailProperties) => (
    <BaseEmail brandLogoUrl={brandLogoUrl} brandName={brandName} brandTagline={brandTagline} previewText="Reset your password">
        <Heading style={styles.h1}>Reset Your Password</Heading>
        <Link
            href={url}
            style={{
                ...styles.link,
                display: "block",
                marginBottom: "16px",
            }}
            target="_blank"
        >
            Click here to reset your password
        </Link>
        <Text
            style={{
                ...styles.text,
                color: "#ababab",
                marginBottom: "16px",
                marginTop: "14px",
            }}
        >
            If you didn&apos;t request a password reset, you can safely ignore this email.
        </Text>
    </BaseEmail>
);

export default ResetPasswordEmail;
