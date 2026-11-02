//! Share native watchers across logical subscriptions. In particular, FSEvents
//! owns a thread per watcher, so one watcher per editor/extension request can
//! exhaust the process thread limit even when requests are otherwise valid.

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

type Handler = Arc<dyn Fn(Event) + Send + Sync>;

struct Subscription {
    paths: Vec<PathBuf>,
    handler: Handler,
}

#[derive(Default)]
struct Group {
    watcher: Option<RecommendedWatcher>,
    paths: HashMap<PathBuf, usize>,
    subscriptions: Arc<Mutex<HashMap<u32, Subscription>>>,
}

impl Group {
    fn add(
        &mut self,
        id: u32,
        paths: Vec<PathBuf>,
        recursive: bool,
        handler: Handler,
    ) -> Result<(), String> {
        if self.watcher.is_none() {
            let subscriptions = self.subscriptions.clone();
            self.watcher = Some(
                RecommendedWatcher::new(
                    move |result: notify::Result<Event>| {
                        let Ok(event) = result else { return };
                        // Never hold the routes lock while calling a subscriber,
                        // or the native watcher lock in its callback: notify's
                        // watch/unwatch/drop may synchronously join that thread.
                        let deliveries: Vec<_> = {
                            let routes = subscriptions.lock().unwrap_or_else(|e| e.into_inner());
                            routes
                                .values()
                                .filter_map(|subscription| {
                                    let paths: Vec<_> = event
                                        .paths
                                        .iter()
                                        .filter(|path| {
                                            subscription
                                                .paths
                                                .iter()
                                                .any(|root| in_scope(path, root, recursive))
                                        })
                                        .cloned()
                                        .collect();
                                    if paths.is_empty() {
                                        None
                                    } else {
                                        let mut scoped = event.clone();
                                        scoped.paths = paths;
                                        Some((subscription.handler.clone(), scoped))
                                    }
                                })
                                .collect()
                        };
                        for (handler, event) in deliveries {
                            handler(event);
                        }
                    },
                    Config::default(),
                )
                .map_err(|e| format!("Failed to create watcher: {e}"))?,
            );
        }
        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        let mut added = Vec::new();
        for path in &paths {
            if !self.paths.contains_key(path) {
                if let Err(error) = self.watcher.as_mut().unwrap().watch(path, mode) {
                    self.release_paths(&added);
                    return Err(format!("Failed to watch '{}': {error}", path.display()));
                }
            }
            *self.paths.entry(path.clone()).or_default() += 1;
            added.push(path.clone());
        }
        self.subscriptions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, Subscription { paths, handler });
        Ok(())
    }

    fn remove(&mut self, id: u32) {
        let subscription = self
            .subscriptions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        if let Some(subscription) = subscription {
            self.release_paths(&subscription.paths);
        }
    }

    fn release_paths(&mut self, paths: &[PathBuf]) {
        for path in paths {
            let Some(count) = self.paths.get_mut(path) else {
                continue;
            };
            *count -= 1;
            if *count == 0 {
                self.paths.remove(path);
                if let Some(watcher) = self.watcher.as_mut() {
                    if let Err(error) = watcher.unwatch(path) {
                        log::warn!("[watch] failed to unwatch '{}': {error}", path.display());
                    }
                }
            }
        }
        if self.paths.is_empty() {
            self.watcher = None;
        }
    }
}

fn in_scope(path: &Path, root: &Path, recursive: bool) -> bool {
    path == root
        || if recursive {
            path.starts_with(root)
        } else {
            path.parent() == Some(root)
        }
}

/// Keep separate native streams for recursive/nonrecursive requests, preserving
/// their OS-level behavior while bounding native watcher threads to two.
#[derive(Clone, Default)]
pub(super) struct WatchBackend(Arc<Mutex<[Group; 2]>>);

impl WatchBackend {
    pub(super) fn subscribe(
        &self,
        id: u32,
        paths: &[PathBuf],
        recursive: bool,
        handler: impl Fn(Event) + Send + Sync + 'static,
    ) -> Result<WatchRegistration, String> {
        let mut normalized = Vec::new();
        for path in paths {
            let path = path.canonicalize().map_err(|e| e.to_string())?;
            if !normalized.contains(&path) {
                normalized.push(path);
            }
        }
        self.0.lock().map_err(|e| e.to_string())?[usize::from(recursive)].add(
            id,
            normalized,
            recursive,
            Arc::new(handler),
        )?;
        Ok(WatchRegistration {
            backend: self.clone(),
            id,
            recursive,
        })
    }
}

pub(super) struct WatchRegistration {
    backend: WatchBackend,
    id: u32,
    recursive: bool,
}

impl Drop for WatchRegistration {
    fn drop(&mut self) {
        self.backend.0.lock().unwrap_or_else(|e| e.into_inner())[usize::from(self.recursive)]
            .remove(self.id);
    }
}
