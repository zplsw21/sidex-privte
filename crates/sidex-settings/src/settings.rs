//! Layered settings store: default < user < workspace.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::defaults::builtin_defaults;
use crate::jsonc::parse_jsonc;

/// Callback type for change notifications.
type ChangeHandler = Box<dyn Fn(&Value) + Send + Sync>;

/// Layered settings store supporting default, user, and workspace layers.
///
/// Lookup order (highest priority first): workspace → user → default.
pub struct Settings {
    default_layer: Value,
    user_layer: Value,
    workspace_layer: Value,
    change_handlers: HashMap<String, Vec<ChangeHandler>>,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings")
            .field("default_layer", &self.default_layer)
            .field("user_layer", &self.user_layer)
            .field("workspace_layer", &self.workspace_layer)
            .field(
                "change_handlers",
                &format!("{} keys", self.change_handlers.len()),
            )
            .finish()
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self::new()
    }
}

impl Settings {
    /// Create a new settings store pre-populated with built-in defaults.
    pub fn new() -> Self {
        Self {
            default_layer: builtin_defaults(),
            user_layer: Value::Object(serde_json::Map::new()),
            workspace_layer: Value::Object(serde_json::Map::new()),
            change_handlers: HashMap::new(),
        }
    }

    /// Load user-level settings from a `settings.json` file (JSONC).
    pub fn load_user(&mut self, path: &Path) -> Result<()> {
        let contents = std::fs::read_to_string(path)
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Ok("{}".to_owned())
                } else {
                    Err(error)
                }
            })
            .context("failed to read user settings file")?;
        let parsed = parse_jsonc(&contents)?;
        let old_layer = std::mem::replace(&mut self.user_layer, parsed);
        self.fire_changes(&old_layer, &self.user_layer.clone());
        Ok(())
    }

    /// Load workspace-level settings from a `settings.json` file (JSONC).
    pub fn load_workspace(&mut self, path: &Path) -> Result<()> {
        let contents =
            std::fs::read_to_string(path).context("failed to read workspace settings file")?;
        let parsed = parse_jsonc(&contents)?;
        let old_layer = std::mem::replace(&mut self.workspace_layer, parsed);
        self.fire_changes(&old_layer, &self.workspace_layer.clone());
        Ok(())
    }

    /// Get a setting value, deserialised into `T`.
    ///
    /// Looks up workspace → user → default layers in order.
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let raw = self.get_raw(key)?;
        serde_json::from_value(raw.clone()).ok()
    }

    /// Get the raw `Value` for a key across all layers.
    pub fn get_raw(&self, key: &str) -> Option<&Value> {
        Self::lookup(&self.workspace_layer, key)
            .or_else(|| Self::lookup(&self.user_layer, key))
            .or_else(|| Self::lookup(&self.default_layer, key))
    }

    /// Get the entire user layer as a JSON value.
    pub fn user_layer(&self) -> &Value {
        &self.user_layer
    }

    /// Get the entire workspace layer as a JSON value.
    pub fn workspace_layer(&self) -> &Value {
        &self.workspace_layer
    }

    /// Set a value in the **user** layer.
    pub fn set(&mut self, key: &str, value: Value) {
        let old = self.get_raw(key).cloned();
        set_in_layer(&mut self.user_layer, key, value);
        if let Some(new) = self.get_raw(key) {
            if old.as_ref() != Some(new) {
                self.fire_handlers(key, new);
            }
        }
    }

    /// Set a value in the **workspace** layer.
    pub fn set_workspace(&mut self, key: &str, value: Value) {
        let old = self.get_raw(key).cloned();
        set_in_layer(&mut self.workspace_layer, key, value);
        if let Some(new) = self.get_raw(key) {
            if old.as_ref() != Some(new) {
                self.fire_handlers(key, new);
            }
        }
    }

    /// Register a callback that fires when the effective value of `key`
    /// changes.
    pub fn on_change<F>(&mut self, key: &str, handler: F)
    where
        F: Fn(&Value) + Send + Sync + 'static,
    {
        self.change_handlers
            .entry(key.to_owned())
            .or_default()
            .push(Box::new(handler));
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    fn lookup<'a>(layer: &'a Value, key: &str) -> Option<&'a Value> {
        layer.as_object()?.get(key)
    }

    fn fire_handlers(&self, key: &str, new_val: &Value) {
        if let Some(handlers) = self.change_handlers.get(key) {
            for h in handlers {
                h(new_val);
            }
        }
    }

    fn fire_changes(&self, old: &Value, new: &Value) {
        let empty = serde_json::Map::new();
        let old_map = old.as_object().unwrap_or(&empty);
        let new_map = new.as_object().unwrap_or(&empty);

        for (key, new_val) in new_map {
            if old_map.get(key) != Some(new_val) {
                if let Some(effective) = self.get_raw(key) {
                    self.fire_handlers(key, effective);
                }
            }
        }

        for key in old_map.keys() {
            if !new_map.contains_key(key) {
                if let Some(effective) = self.get_raw(key) {
                    self.fire_handlers(key, effective);
                }
            }
        }
    }
}

fn set_in_layer(layer: &mut Value, key: &str, value: Value) {
    if let Some(obj) = layer.as_object_mut() {
        obj.insert(key.to_owned(), value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[test]
    fn get_default_value() {
        let s = Settings::new();
        let size: i64 = s.get("editor.fontSize").unwrap();
        assert_eq!(size, 14);
    }

    #[test]
    fn user_overrides_default() {
        let mut s = Settings::new();
        s.set("editor.fontSize", json!(18));
        let size: i64 = s.get("editor.fontSize").unwrap();
        assert_eq!(size, 18);
    }

    #[test]
    fn workspace_overrides_user() {
        let mut s = Settings::new();
        s.set("editor.fontSize", json!(18));
        s.set_workspace("editor.fontSize", json!(22));
        let size: i64 = s.get("editor.fontSize").unwrap();
        assert_eq!(size, 22);
    }

    #[test]
    fn missing_key_returns_none() {
        let s = Settings::new();
        let val: Option<String> = s.get("nonexistent.key");
        assert!(val.is_none());
    }

    #[test]
    fn on_change_fires() {
        let mut s = Settings::new();
        let observed = Arc::new(Mutex::new(None));
        let obs_clone = Arc::clone(&observed);
        s.on_change("editor.fontSize", move |v| {
            *obs_clone.lock().unwrap() = Some(v.clone());
        });
        s.set("editor.fontSize", json!(20));
        let val = observed.lock().unwrap().clone().unwrap();
        assert_eq!(val, json!(20));
    }

    #[test]
    fn on_change_not_fired_for_same_value() {
        let mut s = Settings::new();
        s.set("editor.fontSize", json!(14));
        let count = Arc::new(Mutex::new(0));
        let count_clone = Arc::clone(&count);
        s.on_change("editor.fontSize", move |_| {
            *count_clone.lock().unwrap() += 1;
        });
        s.set("editor.fontSize", json!(14));
        assert_eq!(*count.lock().unwrap(), 0);
    }

    #[test]
    fn get_typed_bool() {
        let s = Settings::new();
        let minimap: bool = s.get("editor.minimap.enabled").unwrap();
        assert!(minimap);
    }

    #[test]
    fn get_typed_string() {
        let s = Settings::new();
        let theme: String = s.get("workbench.colorTheme").unwrap();
        assert_eq!(theme, "Default Dark+");
    }
}
