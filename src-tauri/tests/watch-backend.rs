//! Native OS regression tests: do not replace notify with a mock.
#[path = "../src/commands/watch_backend.rs"]
mod watch_backend;

use notify::Event;
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};
use watch_backend::WatchBackend;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "sidex-watch-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(path.join("a/nested")).unwrap();
        fs::create_dir_all(path.join("b")).unwrap();
        Self(path.canonicalize().unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn receive_path(rx: &Receiver<Event>, path: &PathBuf) -> Vec<Event> {
    let mut received = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        let matched = event.paths.contains(path);
        received.push(event);
        if matched {
            return received;
        }
    }
}

#[cfg(target_os = "macos")]
fn thread_count() -> usize {
    let output = std::process::Command::new("/bin/ps")
        .args(["-M", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .skip(1)
        .count()
}

#[test]
fn thousands_of_subscriptions_share_native_threads_and_release_them() {
    let fixture = Fixture::new();
    let backend = WatchBackend::default();
    #[cfg(target_os = "macos")]
    let baseline = thread_count();
    let mut registrations = Vec::new();
    for index in 0..64 {
        fs::create_dir(fixture.0.join(format!("root-{index}"))).unwrap();
    }
    // Thousands of requests across distinct roots, callbacks and modes.
    for id in 1..=4200 {
        registrations.push(
            backend
                .subscribe(
                    id,
                    &[fixture.0.join(format!("root-{}", id % 64))],
                    id % 2 == 0,
                    |_| {},
                )
                .unwrap(),
        );
    }
    #[cfg(target_os = "macos")]
    {
        let active = thread_count();
        eprintln!("native thread count: baseline={baseline}, 4200 subscriptions={active}");
        assert!(
            active <= baseline + 2,
            "native thread count grew with subscriptions"
        );
    }
    registrations.clear();
    #[cfg(target_os = "macos")]
    assert!(
        thread_count() <= baseline,
        "native threads were not released"
    );
    // A fresh stream must still be usable after complete teardown.
    let (tx, rx) = mpsc::channel();
    let _registration = backend
        .subscribe(5000, &[fixture.0.clone()], true, move |e| {
            tx.send(e).unwrap();
        })
        .unwrap();
    let file = fixture.0.join("after-restart.txt");
    fs::write(&file, "ok").unwrap();
    receive_path(&rx, &file);
}

#[test]
fn shared_streams_preserve_scope_recursion_reference_counts_and_disposal() {
    let fixture = Fixture::new();
    let backend = WatchBackend::default();
    let root = fixture.0.join("a");
    let (tx_recursive, rx_recursive) = mpsc::channel();
    let recursive = backend
        .subscribe(1, &[root.clone()], true, move |e| {
            let _ = tx_recursive.send(e);
        })
        .unwrap();
    let (tx_shared, rx_shared) = mpsc::channel();
    let shared = backend
        .subscribe(2, &[root.clone(), root.join(".")], true, move |e| {
            let _ = tx_shared.send(e);
        })
        .unwrap();
    let (tx_shallow, rx_shallow) = mpsc::channel();
    let _shallow = backend
        .subscribe(3, &[root.clone()], false, move |e| {
            let _ = tx_shallow.send(e);
        })
        .unwrap();
    let (tx_peer, rx_peer) = mpsc::channel();
    let _peer = backend
        .subscribe(4, &[fixture.0.join("b")], true, move |e| {
            let _ = tx_peer.send(e);
        })
        .unwrap();
    let nested = root.join("nested/file.txt");
    let direct = root.join("direct.txt");
    let peer = fixture.0.join("b/peer.txt");
    fs::write(&nested, "nested").unwrap();
    fs::write(&direct, "direct").unwrap();
    fs::write(&peer, "peer").unwrap();
    receive_path(&rx_recursive, &nested);
    receive_path(&rx_shared, &nested);
    let shallow_events = receive_path(&rx_shallow, &direct);
    let peer_events = receive_path(&rx_peer, &peer);
    assert!(shallow_events.iter().all(|e| e
        .paths
        .iter()
        .all(|p| p == &root || p.parent() == Some(root.as_path()))));
    assert!(peer_events
        .iter()
        .all(|e| e.paths.iter().all(|p| p.starts_with(fixture.0.join("b")))));
    std::thread::sleep(Duration::from_millis(200));
    assert!(rx_shallow
        .try_iter()
        .all(|e| e.paths.iter().all(|p| p != &nested && p != &peer)));
    assert!(rx_peer
        .try_iter()
        .all(|e| e.paths.iter().all(|p| p.starts_with(fixture.0.join("b")))));
    // Removing either duplicate must leave the other live, and not deliver to
    // the removed subscription even though the same OS stream is still active.
    drop(recursive);
    while rx_recursive.try_recv().is_ok() {}
    fs::write(&nested, "changed").unwrap();
    receive_path(&rx_shared, &nested);
    assert!(rx_recursive
        .recv_timeout(Duration::from_millis(200))
        .is_err());
    drop(shared);
    fs::write(&direct, "still shallow").unwrap();
    receive_path(&rx_shallow, &direct);
}

#[test]
fn invalid_subscription_does_not_disturb_existing_watchers() {
    let fixture = Fixture::new();
    let backend = WatchBackend::default();
    let (tx, rx) = mpsc::channel();
    let _live = backend
        .subscribe(1, &[fixture.0.clone()], true, move |e| {
            let _ = tx.send(e);
        })
        .unwrap();
    assert!(backend
        .subscribe(
            2,
            &[fixture.0.clone(), fixture.0.join("missing")],
            true,
            |_| {}
        )
        .is_err());
    let file = fixture.0.join("retained.txt");
    fs::write(&file, "ok").unwrap();
    receive_path(&rx, &file);
}

#[test]
fn overlapping_roots_stay_isolated_while_subscriptions_churn() {
    let fixture = Fixture::new();
    let backend = WatchBackend::default();
    let root = fixture.0.join("a");
    let child = root.join("nested");
    let sibling = fixture.0.join("a-extra");
    fs::create_dir(&sibling).unwrap();
    let (tx, rx) = mpsc::channel();
    let _parent = backend.subscribe(1, &[root.clone()], true, |_| {}).unwrap();
    let _child = backend
        .subscribe(2, &[child.clone()], true, move |e| {
            let _ = tx.send(e);
        })
        .unwrap();
    let writer_root = child.clone();
    let writer = std::thread::spawn(move || {
        for i in 0..50 {
            fs::write(writer_root.join("busy.txt"), i.to_string()).unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
    });
    for id in 3..53 {
        let registration = backend
            .subscribe(id, &[sibling.clone()], true, |_| {})
            .unwrap();
        drop(registration);
    }
    writer.join().unwrap();
    fs::write(root.join("outside-child.txt"), "outside").unwrap();
    let file = child.join("after-churn.txt");
    fs::write(&file, "ok").unwrap();
    assert!(receive_path(&rx, &file)
        .iter()
        .all(|e| e.paths.iter().all(|p| p.starts_with(&child))));
}
