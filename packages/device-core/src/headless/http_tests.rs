use super::validate_backend_with;

#[test]
fn takes_https_only_and_loopback_only_with_the_dev_flag() {
    assert_eq!(
        validate_backend_with("https://neore.ai/", false).as_deref(),
        Ok("https://neore.ai")
    );
    for local in [
        "http://localhost:8788",
        "http://127.0.0.1:8788",
        "http://[::1]:8788",
    ] {
        assert!(
            validate_backend_with(local, false).is_err(),
            "{local} was accepted without the dev flag"
        );
        assert_eq!(validate_backend_with(local, true).as_deref(), Ok(local));
    }

    assert!(validate_backend_with("https://localhost:8788", false).is_err());
    assert!(validate_backend_with("https://localhost:8788", true).is_ok());

    for bad in [
        "http://neore.ai",
        "http://localhost.evil.test",
        "ftp://neore.ai",
        "neore.ai",
        "https://",
        "https://user@neore.ai",
        "https://neore.ai/path?x=1",
        "https://neore.ai/api/auth",
        "https://neore.ai/app/",
        "",
    ] {
        for dev in [false, true] {
            assert!(
                validate_backend_with(bad, dev).is_err(),
                "{bad} was accepted"
            );
        }
    }
}
