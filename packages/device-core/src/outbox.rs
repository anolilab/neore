//! A pipe's writer thread with a bounded queue in front of it.
//!
//! Both ends of the host connection write to a pipe that another machine drains: `neore-host` to its stdout, the
//! desktop to ssh's stdin. A write to a pipe the far side stopped reading blocks for as long as it stays stopped, and
//! when the caller is the loop that reads requests (or an Electron main-process call) everything else stops with it.
//! So no caller writes the pipe itself: it queues a frame here and one thread writes them, in order, whole.
//!
//! The queue is counted in bytes. [`Outbox::send`] waits for room, which is the backpressure a producer such as an
//! agent's output or an archive wants. [`Outbox::offer`] and [`Outbox::offer_urgent`] never wait: they refuse when the
//! pipe has not drained, the urgent one with a little more room so a cancel still queues behind a full buffer of data.
//! A refusal means the pipe is not draining, and what to do about it is the caller's.

use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};

use crate::frame::write_frame;

/// Room beyond the limit that only an urgent frame (a cancel, a refusal) may use.
pub const URGENT_HEADROOM: usize = 1024 * 1024;

#[derive(Default)]
struct Queue {
    bytes: usize,
    closed: bool,
    failed: bool,
    frames: VecDeque<Vec<u8>>,
}

struct Shared {
    limit: usize,
    queue: Mutex<Queue>,
    ready: Condvar,
    space: Condvar,
}

/// The sending side. Cheap to clone; every clone feeds the same writer thread.
#[derive(Clone)]
pub struct Outbox(Arc<Shared>);

impl Outbox {
    /// Starts the writer thread for `writer`. The handle is joined after [`Outbox::close`] to wait for the queue to be
    /// written out.
    pub fn new<W: Write + Send + 'static>(mut writer: W, limit: usize) -> (Outbox, JoinHandle<()>) {
        let shared = Arc::new(Shared {
            limit,
            queue: Mutex::new(Queue::default()),
            ready: Condvar::new(),
            space: Condvar::new(),
        });
        let outbox = Outbox(Arc::clone(&shared));
        let handle = thread::spawn(move || loop {
            let frame = {
                let mut queue = shared.queue.lock().unwrap();

                loop {
                    if let Some(frame) = queue.frames.pop_front() {
                        break Some(frame);
                    }

                    if queue.closed {
                        break None;
                    }

                    queue = shared.ready.wait(queue).unwrap();
                }
            };
            let Some(frame) = frame else { return };
            let written = writer.write_all(&frame).and_then(|()| writer.flush());
            let mut queue = shared.queue.lock().unwrap();

            queue.bytes -= frame.len();

            if written.is_err() {
                queue.failed = true;
                queue.frames.clear();
                queue.bytes = 0;
                shared.space.notify_all();

                return;
            }

            shared.space.notify_all();
        });

        (outbox, handle)
    }

    /// Queues one frame, waiting while the queue is over its limit. Fails once the pipe broke or the outbox closed.
    pub fn send(&self, payload: &[u8]) -> io::Result<()> {
        let frame = framed(payload)?;
        let mut queue = self.0.queue.lock().unwrap();

        // A frame bigger than the limit still goes through an empty queue.
        while !queue.failed
            && !queue.closed
            && queue.bytes > 0
            && queue.bytes + frame.len() > self.0.limit
        {
            queue = self.0.space.wait(queue).unwrap();
        }

        self.push(queue, frame)
    }

    /// Queues one frame without waiting; `WouldBlock` when the pipe has not drained.
    pub fn offer(&self, payload: &[u8]) -> io::Result<()> {
        self.offer_within(payload, self.0.limit)
    }

    /// [`Outbox::offer`] with [`URGENT_HEADROOM`] more room.
    pub fn offer_urgent(&self, payload: &[u8]) -> io::Result<()> {
        self.offer_within(payload, self.0.limit + URGENT_HEADROOM)
    }

    /// No more frames are accepted; those queued are still written.
    pub fn close(&self) {
        self.0.queue.lock().unwrap().closed = true;
        self.0.ready.notify_all();
        self.0.space.notify_all();
    }

    fn offer_within(&self, payload: &[u8], limit: usize) -> io::Result<()> {
        let frame = framed(payload)?;
        let queue = self.0.queue.lock().unwrap();

        if !queue.failed && !queue.closed && queue.bytes > 0 && queue.bytes + frame.len() > limit {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "the connection is not keeping up",
            ));
        }

        self.push(queue, frame)
    }

    fn push(&self, mut queue: std::sync::MutexGuard<'_, Queue>, frame: Vec<u8>) -> io::Result<()> {
        if queue.failed {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "the connection was lost",
            ));
        }

        if queue.closed {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "the connection is closing",
            ));
        }

        queue.bytes += frame.len();
        queue.frames.push_back(frame);
        self.0.ready.notify_one();

        Ok(())
    }
}

fn framed(payload: &[u8]) -> io::Result<Vec<u8>> {
    let mut frame = Vec::with_capacity(4 + payload.len());

    write_frame(&mut frame, payload)?;

    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Sender};
    use std::time::{Duration, Instant};

    /// A pipe the far side reads only when the test says so.
    struct Gated {
        gate: std::sync::mpsc::Receiver<()>,
        written: Sender<Vec<u8>>,
    }

    impl Write for Gated {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.gate
                .recv()
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "gone"))?;
            let _ = self.written.send(bytes.to_vec());

            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn frames_are_written_whole_and_in_order() {
        let (written, seen) = channel();
        let (open, gate) = channel();
        let (outbox, writer) = Outbox::new(Gated { gate, written }, 1024);

        for _ in 0..3 {
            open.send(()).unwrap();
        }

        outbox.send(b"one").unwrap();
        outbox.send(b"two").unwrap();
        outbox.send(b"three").unwrap();
        outbox.close();
        writer.join().unwrap();

        let all: Vec<u8> = seen.try_iter().flatten().collect();

        assert_eq!(
            all,
            [
                &[0, 0, 0, 3][..],
                b"one",
                &[0, 0, 0, 3],
                b"two",
                &[0, 0, 0, 5],
                b"three"
            ]
            .concat()
        );
    }

    #[test]
    fn a_stalled_pipe_never_blocks_an_offer() {
        let (written, _seen) = channel();
        let (_open, gate) = channel::<()>();
        let (outbox, _writer) = Outbox::new(Gated { gate, written }, 1000);
        let started = Instant::now();
        let mut refused = false;

        // The writer takes the first frame and stalls inside it; the rest pile up to the limit and no further.
        for _ in 0..100 {
            if outbox.offer(&[0u8; 100]).is_err() {
                refused = true;

                break;
            }
        }

        assert!(refused, "the queue is bounded");
        assert!(started.elapsed() < Duration::from_secs(1));
        // An urgent frame still has room behind a full queue.
        assert!(outbox.offer_urgent(b"cancel").is_ok());
    }

    #[test]
    fn a_blocked_send_gives_up_when_the_pipe_breaks() {
        let (written, _seen) = channel();
        let (open, gate) = channel::<()>();
        let (outbox, _writer) = Outbox::new(Gated { gate, written }, 100);

        outbox.send(&[0u8; 200]).unwrap();

        let blocked = outbox.clone();
        let sender = thread::spawn(move || blocked.send(&[0u8; 200]));

        thread::sleep(Duration::from_millis(100));
        // The far side goes away: the writer's next write fails.
        drop(open);

        assert!(sender.join().unwrap().is_err());
    }
}
