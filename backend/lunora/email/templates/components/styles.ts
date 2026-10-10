/**
 * Shared inline styles for the email templates.
 *
 * Split out of `base-email.tsx` so that file exports only components.
 */
export const styles = {
    code: {
        backgroundColor: "#f4f4f4",
        border: "1px solid #eee",
        borderRadius: "5px",
        color: "#333",
        display: "inline-block",
        padding: "16px 4.5%",
        width: "90.5%",
    },
    container: {
        margin: "0 auto",
        paddingLeft: "12px",
        paddingRight: "12px",
    },
    footer: {
        color: "#898989",
        fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
        fontSize: "12px",
        lineHeight: "22px",
        marginBottom: "24px",
        marginTop: "12px",
    },
    h1: {
        color: "#333",
        fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
        fontSize: "24px",
        fontWeight: "bold",
        margin: "40px 0",
        padding: "0",
    },
    link: {
        color: "#2754C5",
        fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
        fontSize: "14px",
        textDecoration: "underline",
    },
    main: {
        backgroundColor: "#ffffff",
    },
    text: {
        color: "#333",
        fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
        fontSize: "14px",
        margin: "24px 0",
    },
};
