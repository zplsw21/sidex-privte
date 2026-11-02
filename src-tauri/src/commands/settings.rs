use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use serde_json::Value;
use sidex_settings::{modify_jsonc, parse_jsonc, Settings};
use tauri::State;

pub struct SettingsStore {
    pub(crate) inner: RwLock<Settings>,
    /// Path of the user settings.json — set during app startup so user-scope
    /// updates can be persisted to disk (otherwise toggles vanish on restart).
    user_path: RwLock<Option<PathBuf>>,
    // Keep a disk refresh from replacing a user update before it is persisted.
    user_io: Mutex<()>,
}

impl SettingsStore {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Settings::new()),
            user_path: RwLock::new(None),
            user_io: Mutex::new(()),
        }
    }

    pub fn load_user(&self, path: &std::path::Path) -> Result<(), String> {
        let _io = self.user_io.lock().map_err(|e| e.to_string())?;
        self.set_user_path(path);
        self.inner
            .write()
            .map_err(|e| e.to_string())?
            .load_user(path)
            .map_err(|e| e.to_string())
    }

    fn refresh_user_layer(&self) -> Result<(), String> {
        let _io = self.user_io.lock().map_err(|e| e.to_string())?;
        self.refresh_user_layer_locked()
    }

    fn refresh_user_layer_locked(&self) -> Result<(), String> {
        let path = self.user_path.read().map_err(|e| e.to_string())?.clone();
        if let Some(path) = path {
            self.inner
                .write()
                .map_err(|e| e.to_string())?
                .load_user(&path)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn update_user(&self, key: &str, value: Value) -> Result<(), String> {
        let _io = self.user_io.lock().map_err(|e| e.to_string())?;
        self.refresh_user_layer_locked()?;
        self.inner
            .write()
            .map_err(|e| e.to_string())?
            .set(key, value);
        if let Err(error) = self.persist_user_layer() {
            log::warn!("failed to persist user settings: {error}");
        }
        Ok(())
    }

    /// Record where the user settings file lives so later updates persist.
    pub fn set_user_path(&self, path: &std::path::Path) {
        if let Ok(mut p) = self.user_path.write() {
            *p = Some(path.to_path_buf());
        }
    }

    /// Serialize the current user layer to the user settings file.
    fn persist_user_layer(&self) -> Result<(), String> {
        let path = match self.user_path.read().map_err(|e| e.to_string())?.clone() {
            Some(p) => p,
            None => return Ok(()), // path unknown (tests/headless) — skip silently
        };
        let layer = {
            let settings = self.inner.read().map_err(|e| e.to_string())?;
            settings.user_layer().clone()
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&layer).map_err(|e| e.to_string())?;
        // Write atomically: unique temp file + rename, so a crash mid-write
        // can't corrupt settings.json and two concurrent persists can't
        // interleave on a shared tmp path.
        let tmp = path.with_extension(format!(
            "json.tmp.{}.{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
        Ok(())
    }

    pub fn load_workspace(&self, path: &std::path::Path) -> Result<(), String> {
        self.inner
            .write()
            .map_err(|e| e.to_string())?
            .load_workspace(path)
            .map_err(|e| e.to_string())
    }
}

/// Get settings.
///
/// - `section`: if provided, returns only the value for that key
/// - `scope`: one of `"user"`, `"workspace"`, or omitted/`"merged"` for the
///   full merged object across all layers
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn settings_get(
    state: State<'_, Arc<SettingsStore>>,
    section: Option<String>,
    scope: Option<String>,
) -> Result<Value, String> {
    if scope.as_deref() == Some("user") {
        state.refresh_user_layer()?;
    }
    let settings = state.inner.read().map_err(|e| e.to_string())?;

    if let Some(key) = section {
        return Ok(settings.get_raw(&key).cloned().unwrap_or(Value::Null));
    }

    match scope.as_deref() {
        Some("user") => Ok(settings.user_layer().clone()),
        Some("workspace") => Ok(settings.workspace_layer().clone()),
        Some("merged") | None => {
            let mut merged = serde_json::Map::new();
            // Collect all keys across layers via the builtin defaults as the
            // canonical key set, then overlay user/workspace via get_raw.
            let defaults = sidex_settings::builtin_defaults();
            if let Some(obj) = defaults.as_object() {
                for key in obj.keys() {
                    if let Some(val) = settings.get_raw(key) {
                        merged.insert(key.clone(), val.clone());
                    }
                }
            }
            Ok(Value::Object(merged))
        }
        Some(other) => Err(format!(
            "invalid scope '{other}': expected \"user\", \"workspace\", or \"merged\""
        )),
    }
}

/// Update a setting.
///
/// `scope` must be `"user"` or `"workspace"`.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn settings_update(
    state: State<'_, Arc<SettingsStore>>,
    key: String,
    value: Value,
    scope: String,
) -> Result<(), String> {
    match scope.as_str() {
        "user" => state.update_user(&key, value)?,
        "workspace" => state
            .inner
            .write()
            .map_err(|e| e.to_string())?
            .set_workspace(&key, value),
        _ => {
            return Err(format!(
                "invalid scope '{scope}': expected \"user\" or \"workspace\""
            ))
        }
    }
    Ok(())
}

/// Load settings from a JSONC file into the specified layer.
///
/// `scope` must be `"user"` or `"workspace"`.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn settings_load(
    state: State<'_, Arc<SettingsStore>>,
    path: String,
    scope: String,
) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    match scope.as_str() {
        "user" => state.load_user(p),
        "workspace" => state.load_workspace(p),
        _ => Err(format!(
            "invalid scope '{scope}': expected \"user\" or \"workspace\""
        )),
    }
}

/// Parse a JSONC string (strips comments & trailing commas) and return the
/// resulting JSON value. Useful for the frontend to preview or validate
/// settings files.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn settings_parse_jsonc(input: String) -> Result<Value, String> {
    parse_jsonc(&input).map_err(|e| e.to_string())
}

/// Edit a value inside a JSONC document by key-path, preserving surrounding
/// comments and formatting. Returns the modified JSONC string.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn settings_modify_jsonc(
    input: String,
    path: Vec<String>,
    value: Value,
) -> Result<String, String> {
    let refs: Vec<&str> = path.iter().map(String::as_str).collect();
    modify_jsonc(&input, &refs, &value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Barrier;

    struct UserFile {
        directory: PathBuf,
        path: PathBuf,
    }

    impl UserFile {
        fn new() -> Self {
            let directory = std::env::temp_dir()
                .join(format!("sidex-user-settings-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            Self {
                path: directory.join("settings.json"),
                directory,
            }
        }

        fn write(&self, content: &str) {
            std::fs::write(&self.path, content).unwrap();
        }
    }

    impl Drop for UserFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn user_jsonc_edits_refresh_and_survive_restart() {
        let file = UserFile::new();
        file.write(r#"{ "thiefBook.currPageNumber": 2 }"#);
        let store = SettingsStore::new();
        store.load_user(&file.path).unwrap();
        store
            .inner
            .write()
            .unwrap()
            .set_workspace("editor.fontSize", json!(22));

        file.write("{\n // External JSONC edit\n \"thiefBook.currPageNumber\": 7,\n}");
        store.refresh_user_layer().unwrap();
        assert_eq!(
            store.inner.read().unwrap().user_layer()["thiefBook.currPageNumber"],
            json!(7)
        );
        assert_eq!(
            store.inner.read().unwrap().get_raw("editor.fontSize"),
            Some(&json!(22))
        );

        // A form update must preserve an external edit even before a read has
        // refreshed the Rust store.
        file.write(r#"{ "thiefBook.currPageNumber": 9 }"#);
        store.update_user("thiefBook.pageSize", json!(80)).unwrap();
        let restarted = SettingsStore::new();
        restarted.load_user(&file.path).unwrap();
        let settings = restarted.inner.read().unwrap();
        assert_eq!(
            settings.get_raw("thiefBook.currPageNumber"),
            Some(&json!(9))
        );
        assert_eq!(settings.get_raw("thiefBook.pageSize"), Some(&json!(80)));
    }

    #[test]
    fn missing_user_file_clears_user_overrides_and_preserves_workspace_and_handlers() {
        let file = UserFile::new();
        file.write(r#"{ "editor.fontSize": 18, "thiefBook.currPageNumber": 5 }"#);
        let store = SettingsStore::new();
        store.load_user(&file.path).unwrap();
        let observed = Arc::new(Mutex::new(Vec::new()));
        {
            let mut settings = store.inner.write().unwrap();
            settings.set_workspace("editor.lineHeight", json!(24));
            let observed = Arc::clone(&observed);
            settings.on_change("editor.fontSize", move |value| {
                observed.lock().unwrap().push(value.clone());
            });
        }
        std::fs::remove_file(&file.path).unwrap();
        store.refresh_user_layer().unwrap();
        let settings = store.inner.read().unwrap();
        assert_eq!(settings.user_layer(), &json!({}));
        assert_eq!(settings.get_raw("editor.fontSize"), Some(&json!(14)));
        assert_eq!(settings.get_raw("editor.lineHeight"), Some(&json!(24)));
        assert_eq!(*observed.lock().unwrap(), vec![json!(14)]);
        assert!(
            !file.path.exists(),
            "reading a missing settings file must not create it"
        );
    }

    #[test]
    fn invalid_jsonc_preserves_last_good_layer_and_file() {
        let file = UserFile::new();
        file.write(r#"{ "thiefBook.currPageNumber": 3 }"#);
        let store = SettingsStore::new();
        store.load_user(&file.path).unwrap();
        let invalid = r#"{ "thiefBook.currPageNumber": }"#;
        file.write(invalid);
        assert!(store.refresh_user_layer().is_err());
        assert!(store.update_user("thiefBook.pageSize", json!(80)).is_err());
        assert_eq!(
            store
                .inner
                .read()
                .unwrap()
                .get_raw("thiefBook.currPageNumber"),
            Some(&json!(3))
        );
        assert_eq!(std::fs::read_to_string(&file.path).unwrap(), invalid);
    }

    #[test]
    fn first_launch_without_user_file_can_persist_a_setting() {
        let file = UserFile::new();
        let store = SettingsStore::new();
        store.set_user_path(&file.path);
        store.refresh_user_layer().unwrap();
        assert_eq!(store.inner.read().unwrap().user_layer(), &json!({}));
        store.update_user("thiefBook.pageSize", json!(60)).unwrap();
        let restarted = SettingsStore::new();
        restarted.load_user(&file.path).unwrap();
        assert_eq!(
            restarted
                .inner
                .read()
                .unwrap()
                .get_raw("thiefBook.pageSize"),
            Some(&json!(60))
        );
    }

    #[test]
    fn unicode_book_path_survives_startup_refresh_and_persistence() {
        let file = UserFile::new();
        let initial_path = file.directory.join("中文书籍-📚.txt");
        std::fs::write(&initial_path, "synthetic").unwrap();
        file.write(&json!({ "thiefBook.filePath": initial_path }).to_string());
        let store = SettingsStore::new();
        store.load_user(&file.path).unwrap();
        assert_eq!(
            store.inner.read().unwrap().get_raw("thiefBook.filePath"),
            Some(&json!(initial_path))
        );

        let changed_path = file.directory.join("新书籍-é-📖.txt");
        std::fs::write(&changed_path, "synthetic").unwrap();
        file.write(&format!(
            "{{ // 中文注释\n \"thiefBook.filePath\": {},\n}}",
            json!(changed_path)
        ));
        store.refresh_user_layer().unwrap();
        {
            let settings = store.inner.read().unwrap();
            let stored_path = settings
                .get_raw("thiefBook.filePath")
                .unwrap()
                .as_str()
                .unwrap();
            assert_eq!(stored_path, changed_path.to_str().unwrap());
            assert!(std::path::Path::new(stored_path).is_file());
        }

        store
            .update_user("thiefBook.currPageNumber", json!(2))
            .unwrap();
        let restarted = SettingsStore::new();
        restarted.load_user(&file.path).unwrap();
        assert_eq!(
            restarted
                .inner
                .read()
                .unwrap()
                .get_raw("thiefBook.filePath"),
            Some(&json!(changed_path))
        );
    }

    #[test]
    fn concurrent_user_reads_and_updates_do_not_roll_back_persisted_values() {
        let file = UserFile::new();
        file.write("{}");
        let store = Arc::new(SettingsStore::new());
        store.load_user(&file.path).unwrap();
        let start = Arc::new(Barrier::new(4));
        let mut workers = Vec::new();
        for writer in 0..3 {
            let store = Arc::clone(&store);
            let start = Arc::clone(&start);
            workers.push(std::thread::spawn(move || {
                start.wait();
                for value in 0..30 {
                    store
                        .update_user(&format!("probe.writer{writer}"), json!(value))
                        .unwrap();
                }
            }));
        }
        start.wait();
        for _ in 0..90 {
            store.refresh_user_layer().unwrap();
        }
        for worker in workers {
            worker.join().unwrap();
        }
        let restarted = SettingsStore::new();
        restarted.load_user(&file.path).unwrap();
        let settings = restarted.inner.read().unwrap();
        for writer in 0..3 {
            assert_eq!(
                settings.get_raw(&format!("probe.writer{writer}")),
                Some(&json!(29))
            );
        }
    }
}
