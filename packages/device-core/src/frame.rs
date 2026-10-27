//! The frames `neore-host` and the desktop exchange over the host's stdin and stdout: a big-endian `u32`
//! length, then that many bytes of JSON. stdout carries frames and nothing else; the host's log is stderr.
//!
//! A length-prefixed stream cannot resynchronise, so a bad length or a stream that ends inside a frame is
//! an error for the caller to end the connection on.

use std::io::{self, Read, Write};

/// The largest frame either side accepts, checked before anything is allocated. An `fs_write` of the
/// 1 MiB file cap, escaped as JSON, fits with room to spare.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Reads one frame. `Ok(None)` is the stream ending cleanly between frames.
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    let mut filled = 0;

    while filled < header.len() {
        match reader.read(&mut header[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }

    let length = u32::from_be_bytes(header) as usize;

    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a {length} byte frame is over the {MAX_FRAME_BYTES} byte limit"),
        ));
    }

    let mut payload = vec![0u8; length];

    reader.read_exact(&mut payload)?;

    Ok(Some(payload))
}

/// Writes one frame with a single `write_all`, so callers sharing a writer under a lock never interleave.
pub fn write_frame(writer: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("a {} byte frame is over the limit", payload.len()),
        ));
    }

    let mut frame = Vec::with_capacity(4 + payload.len());

    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    writer.write_all(&frame)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_the_stream_ends_cleanly() {
        let mut wire = Vec::new();

        write_frame(&mut wire, b"{\"a\":1}").unwrap();
        write_frame(&mut wire, b"").unwrap();

        let mut reader = wire.as_slice();

        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), b"{\"a\":1}");
        assert_eq!(read_frame(&mut reader).unwrap().unwrap(), b"");
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn an_oversized_length_is_refused_before_anything_is_read() {
        let mut wire = (MAX_FRAME_BYTES as u32 + 1).to_be_bytes().to_vec();

        wire.extend_from_slice(b"x");

        assert_eq!(
            read_frame(&mut wire.as_slice()).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(write_frame(&mut Vec::new(), &vec![0; MAX_FRAME_BYTES + 1]).is_err());
    }

    #[test]
    fn a_stream_that_ends_inside_a_frame_is_an_error() {
        let mut inside_header = &[0u8, 0][..];
        let mut inside_payload = &[0u8, 0, 0, 5, b'a', b'b'][..];

        assert_eq!(
            read_frame(&mut inside_header).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(
            read_frame(&mut inside_payload).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
