//! The "common dependencies only" network tier: a filtering proxy on the loopback that a sandboxed program
//! (`shell_run`, a local MCP server) reaches through `HTTPS_PROXY`, and the fixed list of hosts it will dial.
//!
//! The proxy is the whole policy. The OS sandbox lets the program connect to ONE destination, the loopback
//! port of its own proxy (`sandbox.rs`, macOS), so a tool that ignores the proxy variables has no network at
//! all, and a tool that honours them can reach only what this file lists. It speaks one request:
//! `CONNECT <host>:443`. Plain-HTTP proxying (`GET http://…`) is refused outright, so everything that crosses
//! is TLS the proxy never opens.
//!
//! What it checks, in order: the request is a `CONNECT` with a header under [`MAX_HEAD`] bytes read within
//! [`HEAD_TIMEOUT`]; the port is 443; the host, lower-cased and without a trailing dot, is EXACTLY a listed
//! name (no wildcards, no IP literals); the name resolves to at least one public address (loopback, private,
//! link-local, CGNAT and other special-use ranges are dropped, which keeps a listed name whose DNS was
//! tampered with from reaching a service on this computer or its LAN). The proxy connects to the address it
//! checked and does not resolve again.
//!
//! What it does not do: it does not see inside the TLS stream, so a listed host that shares an address with
//! other tenants of a CDN could be reached under another name (domain fronting), and a listed host receives
//! whatever the program sends it. Both are said in the approval prompt ([`crate::sandbox`]).

use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// The hosts the tier admits, each with the tools that need it. Written from what those tools contact, and
/// kept short on purpose: an entry is a place a sandboxed program can send data, so it earns its line. Exact
/// names only.
///
/// `measure_dependency_hosts` (below, `--ignored`) runs `npx`, `uvx`, `cargo fetch`, `git ls-remote` and a
/// GitHub release download through the real filter in the real sandbox. Those reached registry.npmjs.org,
/// pypi.org, files.pythonhosted.org, index.crates.io, static.crates.io, github.com and (the release download's
/// redirect) release-assets.githubusercontent.com, and nothing else. The remaining entries come from the tools'
/// documented defaults and were not exercised: yarn's registry alias, node-gyp's header host, the Go module
/// proxy and checksum database, RubyGems, and GitHub's archive and older asset hosts.
pub const DEPENDENCY_HOSTS: &[(&str, &str)] = &[
    // JavaScript
    (
        "registry.npmjs.org",
        "npm, npx, pnpm and bun: package metadata and tarballs",
    ),
    (
        "registry.yarnpkg.com",
        "yarn: the registry alias it writes into lockfiles",
    ),
    ("nodejs.org", "node-gyp: Node headers for native addons"),
    // Python
    ("pypi.org", "pip, uv and uvx: the package index"),
    (
        "files.pythonhosted.org",
        "pip, uv and uvx: wheels and source distributions",
    ),
    // Rust
    ("index.crates.io", "cargo: the sparse index"),
    ("static.crates.io", "cargo: crate downloads"),
    // Go
    ("proxy.golang.org", "go: the module proxy"),
    ("sum.golang.org", "go: the checksum database"),
    // Ruby
    ("rubygems.org", "gem and bundler: downloads"),
    ("index.rubygems.org", "bundler: the compact index"),
    // Source hosts
    (
        "github.com",
        "git clone over https; release downloads start here",
    ),
    (
        "codeload.github.com",
        "archives of a repository or tag (npm and cargo git dependencies)",
    ),
    (
        "objects.githubusercontent.com",
        "release assets and large objects GitHub redirects to",
    ),
    (
        "release-assets.githubusercontent.com",
        "release assets (uv's managed Python builds, tool releases)",
    ),
];

/// The only port a tunnel may name.
const HTTPS_PORT: u16 = 443;

/// The longest request header the proxy reads. A `CONNECT` is a few dozen bytes; a client that sends more is not one.
pub const MAX_HEAD: usize = 8 * 1024;

/// How long a client has to finish its request header.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the proxy waits to reach a listed host.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Tunnels open at once. A package install opens a handful; more is a program fanning out, and is refused with 503.
const MAX_CONNECTIONS: usize = 128;

/// How often a pump re-reads the stop flag while its socket is quiet.
const POLL: Duration = Duration::from_millis(250);

/// The distinct hosts a run was refused, kept for the error message (most recent first dropped past this).
const MAX_REFUSED: usize = 20;

/// A host as the list spells it: lower case, without a trailing dot.
fn normalized(host: &str) -> String {
    host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase()
}

/// Whether `host` is one of [`DEPENDENCY_HOSTS`].
pub fn is_listed(host: &str) -> bool {
    let host = normalized(host);

    DEPENDENCY_HOSTS.iter().any(|(listed, _)| *listed == host)
}

/// The environment that points a program at the proxy on `port`. `127.0.0.1`, not `localhost`: the program does
/// no lookup. `NO_PROXY` is emptied so nothing is exempt, and `NODE_USE_ENV_PROXY` makes Node's own `fetch` and
/// `https` honour the variables, which they ignore otherwise.
pub fn proxy_env(port: u16) -> Vec<(&'static str, String)> {
    let url = format!("http://127.0.0.1:{port}");

    vec![
        ("HTTP_PROXY", url.clone()),
        ("HTTPS_PROXY", url.clone()),
        ("http_proxy", url.clone()),
        ("https_proxy", url),
        ("NO_PROXY", String::new()),
        ("no_proxy", String::new()),
        ("NODE_USE_ENV_PROXY", "1".to_owned()),
    ]
}

/// Whether an address is one a listed name may legitimately resolve to.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();

    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        // 100.64.0.0/10 (carrier-grade NAT), 192.0.0.0/24 (IETF protocol assignments),
        // 198.18.0.0/15 (benchmarking), 240.0.0.0/4 (reserved).
        || (a == 100 && (64..128).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (18..20).contains(&b))
        || a >= 240)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();

    // An IPv4 address in an IPv6 coat (mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`) is judged as the IPv4 one.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }

    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        let [high, low] = [segments[6].to_be_bytes(), segments[7].to_be_bytes()];

        return is_public_v4(Ipv4Addr::new(high[0], high[1], low[0], low[1]));
    }

    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        // fc00::/7 unique local, fe80::/10 link local, fec0::/10 site local.
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        // 2001:db8::/32 documentation.
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

/// How the proxy reaches a listed host. The real one resolves and connects to a public address; a test hands in
/// one that dials a listener of its own.
pub type Dial = Arc<dyn Fn(&str, u16) -> io::Result<TcpStream> + Send + Sync>;

fn dial_public(host: &str, port: u16) -> io::Result<TcpStream> {
    let mut last = io::Error::new(
        io::ErrorKind::PermissionDenied,
        "the name resolves only to non-public addresses",
    );

    for address in (host, port)
        .to_socket_addrs()?
        .filter(|address| is_public(address.ip()))
    {
        match TcpStream::connect_timeout(&address, DIAL_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = error,
        }
    }

    Err(last)
}

/// Why a request was not a tunnel to a listed host.
#[derive(Debug, PartialEq, Eq)]
struct Refusal {
    /// The host the request named, when it named one: what the user is told was blocked.
    host: Option<String>,
    reason: &'static str,
    status: u16,
}

fn refusal(status: u16, reason: &'static str, host: Option<String>) -> Refusal {
    Refusal {
        host,
        reason,
        status,
    }
}

/// The host a request line asks for: `CONNECT <host>:443 HTTP/1.x` to a listed name, else why not.
fn parse_connect(head: &str) -> Result<String, Refusal> {
    let line = head.lines().next().unwrap_or_default();
    let mut parts = line.split_ascii_whitespace();
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(refusal(400, "malformed request", None));
    };

    if !version.starts_with("HTTP/1.") {
        return Err(refusal(400, "malformed request", None));
    }

    if !method.eq_ignore_ascii_case("CONNECT") {
        // `GET http://host/…`: name the host, so the message can say what was refused.
        let host = target
            .split_once("://")
            .map(|(_, rest)| rest.split(['/', ':']).next().unwrap_or_default().to_owned())
            .filter(|host| !host.is_empty());

        return Err(refusal(
            405,
            "only HTTPS through CONNECT is supported",
            host,
        ));
    }

    let Some((host, port)) = target.rsplit_once(':') else {
        return Err(refusal(400, "malformed request", None));
    };
    let host = normalized(host);

    if port.parse::<u16>() != Ok(HTTPS_PORT) {
        return Err(refusal(403, "only port 443 is allowed", Some(host)));
    }

    if !is_listed(&host) {
        return Err(refusal(
            403,
            "that host is not on the common dependencies list",
            Some(host),
        ));
    }

    Ok(host)
}

/// Reads the request header: everything up to the blank line, and any bytes the client sent after it.
fn read_head(client: &mut TcpStream) -> Result<(String, Vec<u8>), Refusal> {
    let started = Instant::now();
    let mut buffer = Vec::with_capacity(512);
    let mut chunk = [0u8; 1024];

    loop {
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            if end > MAX_HEAD {
                return Err(refusal(431, "the request header is too large", None));
            }

            let rest = buffer.split_off(end + 4);

            return Ok((String::from_utf8_lossy(&buffer).into_owned(), rest));
        }

        if buffer.len() > MAX_HEAD {
            return Err(refusal(431, "the request header is too large", None));
        }

        let left = HEAD_TIMEOUT
            .checked_sub(started.elapsed())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| refusal(408, "the request header took too long", None))?;

        client
            .set_read_timeout(Some(left))
            .map_err(|_| refusal(400, "malformed request", None))?;

        match client.read(&mut chunk) {
            Ok(0) => return Err(refusal(400, "malformed request", None)),
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(_) => return Err(refusal(408, "the request header took too long", None)),
        }
    }
}

fn respond(client: &mut TcpStream, status: u16, reason: &str) {
    let text = match status {
        200 => "Connection Established",
        400 => "Bad Request",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        _ => "Service Unavailable",
    };
    let body = if status == 200 { "" } else { reason };

    // Best effort: the client may already be gone.
    let _ = write!(
        client,
        "HTTP/1.1 {status} {text}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Answers a request the proxy will not serve and closes without a reset: a client still sending (an oversized
/// header) would otherwise get its connection reset before it could read the reason.
fn refuse_and_close(client: &mut TcpStream, status: u16, reason: &str) {
    respond(client, status, reason);

    let _ = client.shutdown(Shutdown::Write);
    let _ = client.set_read_timeout(Some(Duration::from_millis(200)));
    let mut sink = [0u8; 4096];

    for _ in 0..16 {
        if !matches!(client.read(&mut sink), Ok(read) if read > 0) {
            break;
        }
    }
}

/// Counts an open connection for as long as it lives.
struct Slot(Arc<AtomicUsize>);

impl Slot {
    fn take(count: &Arc<AtomicUsize>) -> Option<Slot> {
        if count.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            count.fetch_sub(1, Ordering::SeqCst);

            return None;
        }

        Some(Slot(count.clone()))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Shared {
    dial: Dial,
    refused: Mutex<Vec<String>>,
    stop: AtomicBool,
}

impl Shared {
    fn note_refused(&self, host: String) {
        let mut refused = self.refused.lock().unwrap();

        if !refused.contains(&host) && refused.len() < MAX_REFUSED {
            refused.push(host);
        }
    }
}

/// Copies `from` to `to` until the end, a failure or the stop flag. Half-closes `to` at a clean end so the other
/// side sees EOF; a failure closes both directions.
fn pump(mut from: TcpStream, mut to: TcpStream, stop: &AtomicBool) {
    let mut chunk = [0u8; 16 * 1024];

    let _ = from.set_read_timeout(Some(POLL));

    loop {
        if stop.load(Ordering::Relaxed) {
            let _ = from.shutdown(Shutdown::Both);
            let _ = to.shutdown(Shutdown::Both);

            return;
        }

        match from.read(&mut chunk) {
            Ok(0) => {
                let _ = to.shutdown(Shutdown::Write);

                return;
            }
            Ok(read) => {
                if to.write_all(&chunk[..read]).is_err() {
                    let _ = from.shutdown(Shutdown::Both);
                    let _ = to.shutdown(Shutdown::Both);

                    return;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => {
                let _ = from.shutdown(Shutdown::Both);
                let _ = to.shutdown(Shutdown::Both);

                return;
            }
        }
    }
}

fn tunnel(client: TcpStream, upstream: TcpStream, shared: &Arc<Shared>) {
    let (Ok(client_reader), Ok(upstream_writer)) = (client.try_clone(), upstream.try_clone())
    else {
        return;
    };
    let forward = {
        let shared = shared.clone();

        thread::spawn(move || pump(client_reader, upstream_writer, &shared.stop))
    };

    pump(upstream, client, &shared.stop);
    let _ = forward.join();
}

fn serve(mut client: TcpStream, shared: &Arc<Shared>) {
    let _ = client.set_nonblocking(false);

    let (head, early) = match read_head(&mut client) {
        Ok(read) => read,
        Err(refused) => {
            refuse_and_close(&mut client, refused.status, refused.reason);

            return;
        }
    };
    let host = match parse_connect(&head) {
        Ok(host) => host,
        Err(refused) => {
            if let Some(host) = refused.host {
                shared.note_refused(host);
            }

            refuse_and_close(&mut client, refused.status, refused.reason);

            return;
        }
    };

    let mut upstream = match (shared.dial)(&host, HTTPS_PORT) {
        Ok(upstream) => upstream,
        Err(_) => {
            refuse_and_close(&mut client, 502, "could not reach that host");

            return;
        }
    };

    respond(&mut client, 200, "");

    // A client that started its handshake before the 200 has those bytes in `early`.
    if !early.is_empty() && upstream.write_all(&early).is_err() {
        return;
    }

    tunnel(client, upstream, shared);
}

/// A running filter. Dropping it stops accepting and ends every open tunnel.
pub struct Proxy {
    accept: Option<JoinHandle<()>>,
    port: u16,
    shared: Arc<Shared>,
}

impl Proxy {
    /// Starts the proxy on a free loopback port, dialing real hosts.
    pub fn start() -> io::Result<Proxy> {
        Proxy::start_with(Arc::new(dial_public))
    }

    /// [`Proxy::start`] with another way to reach a listed host.
    pub fn start_with(dial: Dial) -> io::Result<Proxy> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let shared = Arc::new(Shared {
            dial,
            refused: Mutex::new(Vec::new()),
            stop: AtomicBool::new(false),
        });

        listener.set_nonblocking(true)?;

        let accept = {
            let shared = shared.clone();

            thread::spawn(move || accept_loop(&listener, &shared))
        };

        Ok(Proxy {
            accept: Some(accept),
            port,
            shared,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The distinct hosts this proxy refused, in the order they were first asked for.
    pub fn refused(&self) -> Vec<String> {
        self.shared.refused.lock().unwrap().clone()
    }

    /// The sentence that tells a user why a program that failed may have been blocked, empty when nothing was.
    pub fn refused_note(&self) -> String {
        let refused = self.refused();

        if refused.is_empty() {
            String::new()
        } else {
            format!(
                " (blocked by the \"common dependencies only\" network setting: {})",
                refused.join(", ")
            )
        }
    }
}

fn accept_loop(listener: &TcpListener, shared: &Arc<Shared>) {
    let open = Arc::new(AtomicUsize::new(0));

    while !shared.stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut client, _)) => {
                let Some(slot) = Slot::take(&open) else {
                    respond(&mut client, 503, "too many connections");

                    continue;
                };
                let shared = shared.clone();

                thread::spawn(move || {
                    serve(client, &shared);
                    drop(slot);
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => thread::sleep(Duration::from_millis(100)),
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);

        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn the_list_is_exact_lower_case_names_with_a_reason_each() {
        let mut seen = std::collections::HashSet::new();

        for (host, why) in DEPENDENCY_HOSTS {
            assert!(seen.insert(*host), "{host} listed twice");
            assert!(!why.is_empty());
            assert_eq!(*host, host.to_ascii_lowercase());
            assert!(host.contains('.'));
            assert!(
                host.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-'),
                "{host}: not a plain host name"
            );
            assert!(host.parse::<IpAddr>().is_err());
        }

        for required in [
            "registry.npmjs.org",
            "pypi.org",
            "files.pythonhosted.org",
            "index.crates.io",
            "static.crates.io",
            "github.com",
            "codeload.github.com",
            "objects.githubusercontent.com",
        ] {
            assert!(is_listed(required), "{required} missing");
        }
    }

    #[test]
    fn the_readme_table_lists_exactly_the_hosts_in_the_code() {
        let readme = include_str!("../README.md");
        let section = readme
            .split("The list (`egress::DEPENDENCY_HOSTS`")
            .nth(1)
            .and_then(|rest| {
                rest.split("`cargo test --lib measure_dependency_hosts")
                    .next()
            })
            .expect("the README has the host table");
        let documented: Vec<&str> = section
            .lines()
            .filter_map(|line| line.strip_prefix("| `"))
            .filter_map(|line| line.split('`').next())
            .collect();
        let coded: Vec<&str> = DEPENDENCY_HOSTS.iter().map(|(host, _)| *host).collect();

        assert_eq!(documented, coded);
    }

    #[test]
    fn matching_is_exact_after_case_and_a_trailing_dot() {
        assert!(is_listed("Registry.NPMJS.org"));
        assert!(is_listed("pypi.org."));
        assert!(!is_listed("evil.pypi.org"));
        assert!(!is_listed("pypi.org.evil.example"));
        assert!(!is_listed("npmjs.org"));
        assert!(!is_listed("githubusercontent.com"));
        assert!(!is_listed("127.0.0.1"));
        assert!(!is_listed(""));
    }

    #[test]
    fn a_request_is_a_connect_to_a_listed_host_on_443() {
        assert_eq!(
            parse_connect("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: x\r\n\r\n"),
            Ok("registry.npmjs.org".to_owned())
        );
        assert_eq!(
            parse_connect("connect PyPI.org.:443 HTTP/1.0\r\n\r\n"),
            Ok("pypi.org".to_owned())
        );

        let status = |head: &str| parse_connect(head).unwrap_err().status;

        assert_eq!(status("CONNECT pypi.org:80 HTTP/1.1\r\n\r\n"), 403);
        assert_eq!(status("CONNECT pypi.org:8443 HTTP/1.1\r\n\r\n"), 403);
        assert_eq!(status("CONNECT pypi.org HTTP/1.1\r\n\r\n"), 400);
        assert_eq!(status("CONNECT evil.example:443 HTTP/1.1\r\n\r\n"), 403);
        assert_eq!(status("CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n"), 403);
        assert_eq!(status("CONNECT [::1]:443 HTTP/1.1\r\n\r\n"), 403);
        assert_eq!(status("CONNECT user@pypi.org:443 HTTP/1.1\r\n\r\n"), 403);
        assert_eq!(status("GET http://pypi.org/simple HTTP/1.1\r\n\r\n"), 405);
        assert_eq!(status("CONNECT pypi.org:443 SPDY/3\r\n\r\n"), 400);
        assert_eq!(status("CONNECT pypi.org:443 HTTP/1.1 extra\r\n\r\n"), 400);
        assert_eq!(status(""), 400);

        // A refused request names its host, so the user can be told what was blocked.
        assert_eq!(
            parse_connect("GET http://example.org:8080/x HTTP/1.1\r\n\r\n")
                .unwrap_err()
                .host
                .as_deref(),
            Some("example.org")
        );
    }

    #[test]
    fn only_public_addresses_are_dialed() {
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "198.18.0.1",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::7f00:1",
            "ff02::1",
            "2001:db8::1",
        ] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }

        for public in [
            "104.16.0.1",
            "140.82.112.3",
            "2606:4700::6810:1",
            "::ffff:8.8.8.8",
        ] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
    }

    #[test]
    fn the_environment_points_everything_at_the_loopback_and_exempts_nothing() {
        let env = proxy_env(4242);
        let value = |name: &str| {
            env.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, v)| v.as_str())
        };

        for name in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            assert_eq!(value(name), Some("http://127.0.0.1:4242"));
        }

        assert_eq!(value("NO_PROXY"), Some(""));
        assert_eq!(value("no_proxy"), Some(""));
        assert_eq!(value("NODE_USE_ENV_PROXY"), Some("1"));
    }

    /// A proxy whose dial goes to a local echo server, and how often it was asked.
    fn echo_proxy() -> (Proxy, Arc<AtomicUsize>, Arc<Mutex<Vec<String>>>) {
        let echo = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = echo.local_addr().unwrap();

        thread::spawn(move || {
            for stream in echo.incoming().map_while(Result::ok) {
                thread::spawn(move || {
                    let mut stream = stream;
                    let mut chunk = [0u8; 256];

                    while let Ok(read) = stream.read(&mut chunk) {
                        if read == 0 || stream.write_all(&chunk[..read]).is_err() {
                            break;
                        }
                    }
                });
            }
        });

        let dialed = Arc::new(AtomicUsize::new(0));
        let hosts = Arc::new(Mutex::new(Vec::new()));
        let dial: Dial = {
            let (dialed, hosts) = (dialed.clone(), hosts.clone());

            Arc::new(move |host, port| {
                dialed.fetch_add(1, Ordering::SeqCst);
                hosts.lock().unwrap().push(format!("{host}:{port}"));

                TcpStream::connect(address)
            })
        };

        (Proxy::start_with(dial).unwrap(), dialed, hosts)
    }

    fn ask(proxy: &Proxy, request: &str) -> (String, TcpStream) {
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port())).unwrap();

        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(request.as_bytes()).unwrap();

        let mut reply = Vec::new();
        let mut byte = [0u8; 1];

        // Up to the end of the header; the body (a refusal's reason) is not needed.
        while !reply.ends_with(b"\r\n\r\n") {
            match client.read(&mut byte) {
                Ok(1) => reply.push(byte[0]),
                _ => break,
            }
        }

        (String::from_utf8_lossy(&reply).into_owned(), client)
    }

    #[test]
    fn a_listed_host_is_tunnelled_and_bytes_cross_both_ways() {
        let (proxy, dialed, hosts) = echo_proxy();
        let (reply, mut client) = ask(
            &proxy,
            "CONNECT Registry.NPMJS.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n",
        );

        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");

        client.write_all(b"hello through the filter").unwrap();

        let mut echoed = [0u8; 24];

        client.read_exact(&mut echoed).unwrap();

        assert_eq!(&echoed, b"hello through the filter");
        assert_eq!(dialed.load(Ordering::SeqCst), 1);
        assert_eq!(hosts.lock().unwrap().as_slice(), ["registry.npmjs.org:443"]);
        assert!(proxy.refused().is_empty());
    }

    #[test]
    fn bytes_sent_before_the_200_reach_the_host() {
        let (proxy, _, _) = echo_proxy();
        let (reply, mut client) = ask(&proxy, "CONNECT pypi.org:443 HTTP/1.1\r\n\r\nclient-hello");

        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");

        let mut echoed = [0u8; 12];

        client.read_exact(&mut echoed).unwrap();

        assert_eq!(&echoed, b"client-hello");
    }

    #[test]
    fn an_unlisted_host_is_refused_without_a_dial_and_remembered() {
        let (proxy, dialed, _) = echo_proxy();

        for request in [
            "CONNECT evil.example:443 HTTP/1.1\r\n\r\n",
            "CONNECT evil.example:443 HTTP/1.1\r\n\r\n",
            "CONNECT 169.254.169.254:443 HTTP/1.1\r\n\r\n",
            "CONNECT pypi.org:80 HTTP/1.1\r\n\r\n",
        ] {
            let (reply, _) = ask(&proxy, request);

            assert!(reply.starts_with("HTTP/1.1 403"), "{request}: {reply}");
        }

        let (reply, _) = ask(
            &proxy,
            "GET http://pypi.org/simple/ HTTP/1.1\r\nHost: pypi.org\r\n\r\n",
        );

        assert!(reply.starts_with("HTTP/1.1 405"), "{reply}");
        assert_eq!(dialed.load(Ordering::SeqCst), 0);
        assert_eq!(
            proxy.refused(),
            ["evil.example", "169.254.169.254", "pypi.org"]
        );
        assert!(proxy.refused_note().contains("evil.example"));
    }

    #[test]
    fn a_listed_host_that_cannot_be_reached_is_a_502() {
        let dial: Dial = Arc::new(|_, _| Err(io::Error::other("down")));
        let proxy = Proxy::start_with(dial).unwrap();
        let (reply, _) = ask(&proxy, "CONNECT pypi.org:443 HTTP/1.1\r\n\r\n");

        assert!(reply.starts_with("HTTP/1.1 502"), "{reply}");
    }

    #[test]
    fn an_oversized_or_unfinished_header_is_refused() {
        let (proxy, dialed, _) = echo_proxy();
        let huge = format!(
            "CONNECT pypi.org:443 HTTP/1.1\r\nX: {}\r\n\r\n",
            "a".repeat(MAX_HEAD + 100)
        );
        let (reply, _) = ask(&proxy, &huge);

        assert!(reply.starts_with("HTTP/1.1 431"), "{reply}");
        assert_eq!(dialed.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn dropping_the_proxy_closes_its_port_and_ends_open_tunnels() {
        let (proxy, _, _) = echo_proxy();
        let port = proxy.port();
        let (_, mut client) = ask(&proxy, "CONNECT pypi.org:443 HTTP/1.1\r\n\r\n");

        drop(proxy);

        // The tunnel ends: the read returns EOF (or a reset) instead of waiting.
        let mut byte = [0u8; 1];

        assert!(!matches!(client.read(&mut byte), Ok(1)));
        assert!(TcpStream::connect_timeout(
            &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            Duration::from_millis(500)
        )
        .is_err());
    }

    /// What the OS sandbox lets a confined program do with the proxy in place. macOS only: it is the one platform
    /// that can name a single allowed destination (`sandbox.rs`).
    #[cfg(target_os = "macos")]
    mod confined {
        use super::*;
        use crate::sandbox::{self, NetworkTier, Policy};
        use std::process::Stdio;

        /// Runs `script` in bash under `policy`; its stdout.
        fn run_confined(policy: &Policy, script: &str) -> String {
            let (mut command, _guard) =
                sandbox::sandboxed_command(policy, "/bin/bash", &["-c", script]).unwrap();
            let output = command
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .unwrap();

            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        fn policy(network: NetworkTier, proxy_port: Option<u16>) -> Policy {
            Policy {
                network,
                proxy_port,
                ..Policy::for_roots(&[std::env::temp_dir()], None)
            }
        }

        /// bash's `/dev/tcp`: `connected` or `refused` for a plain connect.
        const PROBE: &str = "probe() { (exec 3<>/dev/tcp/$1/$2) 2>/dev/null && echo \"$3:connected\" || echo \"$3:refused\"; }\n";

        fn skip() -> bool {
            !matches!(sandbox::support(), sandbox::Support::Available(_))
        }

        #[test]
        fn a_confined_program_reaches_the_proxy_and_nothing_else() {
            if skip() {
                return;
            }

            let (proxy, dialed, _) = echo_proxy();
            // Another loopback service: reachable from a program with the network on, not from this tier.
            let other = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let other_port = other.local_addr().unwrap().port();
            // The same on the IPv6 loopback, when this computer has one.
            let other_v6 = TcpListener::bind("[::1]:0").ok();
            let v6_probe = other_v6.as_ref().map_or(String::new(), |listener| {
                format!(
                    "probe ::1 {} other-v6\n",
                    listener.local_addr().unwrap().port()
                )
            });
            let script = format!(
                "{PROBE}probe 127.0.0.1 {} proxy\nprobe 127.0.0.1 {other_port} other-loopback\nprobe localhost {other_port} other-localhost\nprobe 1.1.1.1 443 public-ip\nprobe 192.168.1.1 443 lan\n{v6_probe}",
                proxy.port()
            );
            let tiered = run_confined(
                &policy(NetworkTier::Dependencies, Some(proxy.port())),
                &script,
            );

            assert!(tiered.contains("proxy:connected"), "{tiered}");

            for blocked in ["other-loopback", "other-localhost", "public-ip", "lan"] {
                assert!(
                    tiered.contains(&format!("{blocked}:refused")),
                    "{blocked}: {tiered}"
                );
            }

            if other_v6.is_some() {
                assert!(tiered.contains("other-v6:refused"), "{tiered}");
            }

            // No proxy port yet (it never reached the profile): as closed as Off, the proxy itself included.
            let closed = run_confined(&policy(NetworkTier::Dependencies, None), &script);

            assert!(!closed.contains("connected"), "{closed}");

            // The control: with the network on, the same loopback probes connect, so "refused" above was the
            // sandbox. (Not the public and LAN ones: with no route those wait for a timeout.)
            let control = format!("{PROBE}probe 127.0.0.1 {other_port} other-loopback\n{v6_probe}");
            let open = run_confined(&policy(NetworkTier::On, None), &control);

            assert!(open.contains("other-loopback:connected"), "{open}");

            if other_v6.is_some() {
                assert!(open.contains("other-v6:connected"), "{open}");
            }

            assert_eq!(dialed.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn through_the_proxy_a_listed_host_is_allowed_and_an_unlisted_one_is_refused() {
            if skip() {
                return;
            }

            let (proxy, dialed, hosts) = echo_proxy();
            let script = |host: &str| {
                format!(
                    "exec 3<>/dev/tcp/127.0.0.1/{}\nprintf 'CONNECT {host}:443 HTTP/1.1\\r\\n\\r\\n' >&3\nread -r status <&3\necho \"$status\"\n",
                    proxy.port()
                )
            };
            let confined = policy(NetworkTier::Dependencies, Some(proxy.port()));
            let listed = run_confined(&confined, &script("registry.npmjs.org"));
            let unlisted = run_confined(&confined, &script("evil.example"));
            let metadata = run_confined(&confined, &script("169.254.169.254"));

            assert!(listed.contains("200"), "{listed}");
            assert!(unlisted.contains("403"), "{unlisted}");
            assert!(metadata.contains("403"), "{metadata}");
            assert_eq!(hosts.lock().unwrap().as_slice(), ["registry.npmjs.org:443"]);
            assert_eq!(dialed.load(Ordering::SeqCst), 1);
            assert_eq!(proxy.refused(), ["evil.example", "169.254.169.254"]);
        }

        /// The whole path as `shell_run` takes it: the run starts its own proxy, points the environment at it, and
        /// a failed command is told which host was blocked.
        #[test]
        fn a_shell_command_under_the_dependencies_tier_sees_the_proxy_and_hears_what_was_blocked() {
            if skip() {
                return;
            }

            let shared = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            let policy = policy(NetworkTier::Dependencies, None);
            let result = crate::shell::run(
                "echo \"proxy=$HTTPS_PROXY\"; /usr/bin/curl -sS -m 5 https://evil.example/ 2>&1; exit 7",
                &shared,
                Duration::from_secs(20),
                8192,
                Some(&policy),
            )
            .unwrap();

            assert!(
                result.output.contains("proxy=http://127.0.0.1:"),
                "{}",
                result.output
            );
            assert_eq!(result.exit_code, Some(7));
            assert!(
                result
                    .output
                    .contains("blocked by the \"common dependencies only\""),
                "{}",
                result.output
            );
            assert!(result.output.contains("evil.example"), "{}", result.output);
        }
    }

    /// Not a test: how the host list was measured. Runs the package launchers through the real filter inside
    /// the real sandbox and prints what each asked for and what the list refused:
    /// `cargo test --lib measure_dependency_hosts -- --ignored --nocapture`. Needs the network.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "uses the network; prints the hosts each tool contacts"]
    fn measure_dependency_hosts() {
        use crate::sandbox::{NetworkTier, Policy};

        let work = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("neore-measure-{}", std::process::id()));

        std::fs::create_dir_all(work.join("crate/src")).unwrap();
        std::fs::write(work.join("crate/src/main.rs"), "fn main() {}").unwrap();
        std::fs::write(
            work.join("crate/Cargo.toml"),
            "[package]\nname = \"m\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[dependencies]\nitoa = \"1\"\n",
        )
        .unwrap();

        let policy = Policy {
            network: NetworkTier::Dependencies,
            ..Policy::for_roots(
                std::slice::from_ref(&work),
                crate::sandbox::home().as_deref(),
            )
        };
        let cases = [
            ("npx", "npx -y cowsay@1.6.0 hi 2>&1 | tail -12; exit 9"),
            ("uvx", "UV_TOOL_DIR=\"$TMPDIR/uvtools\" uvx --no-progress cowsay 2>&1 | tail -6; exit 9"),
            (
                "cargo",
                "cd crate && CARGO_HOME=\"$TMPDIR/cargo\" cargo fetch 2>&1 | tail -3; exit 9",
            ),
            (
                "release",
                "curl -sIL -m 30 https://github.com/astral-sh/uv/releases/download/0.5.0/uv-aarch64-apple-darwin.tar.gz 2>&1 | grep -i '^HTTP\\|^location'; exit 9",
            ),
            ("npm-git", "GIT_CONFIG_GLOBAL=/dev/null npm view github:sindresorhus/is-odd name 2>&1 | tail -4; exit 9"),
            ("git", "GIT_CONFIG_GLOBAL=/dev/null git ls-remote https://github.com/rust-lang/cfg-if HEAD 2>&1 | tail -2; exit 9"),
        ];

        for (name, line) in cases {
            let result = crate::shell::run(
                line,
                &work,
                Duration::from_secs(240),
                16 * 1024,
                Some(&policy),
            );

            println!(
                "== {name}\n{}\n",
                result.map(|r| r.output).unwrap_or_else(|e| e)
            );
        }

        let _ = std::fs::remove_dir_all(&work);
    }
}
