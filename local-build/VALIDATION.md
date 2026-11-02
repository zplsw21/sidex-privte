# Pre-commit validation — 2026-11-02

Environment: macOS 26.5.1 arm64, Node.js 24.21.0, TypeScript 5.6.3,
rustc/cargo 1.91.1. Commands ran against the current working tree before deleting
build output. Test counts below have no failures or skipped tests.

| Check | Command or procedure | Result |
|---|---|---|
| Extension host, resources, watcher routing and Thief-Book | `node --test src-tauri/tests/*.test.cjs local-build/thief-book/test/extension.test.cjs` | 66 passed |
| Worker lifecycle and fallback | `node --test scripts/test-worker-lifecycle.mjs` | 19 passed |
| Worker localization | `node --experimental-vm-modules scripts/test-worker-nls.mjs` | 9 scenarios passed |
| Existing production Worker | `node --experimental-vm-modules scripts/test-built-editor-worker.mjs` | Initialization, ping and 10 diff cases passed |
| Host bridge, keybindings and local resources | The three corresponding `local-build/verify-*.cjs` scripts | Passed |
| ESM shim | Two starts in the original directory and two in a temporary path with spaces and Unicode | 177 named exports and API identity passed each time; resource hashes unchanged |
| Modified TypeScript files | ESLint on all 12 modified TS files | No errors or warnings |
| Settings crate | `./local-build/cargo-local.sh test -p sidex-settings --locked --offline` | 84 passed |
| Tauri settings commands | From `src-tauri`: `../local-build/cargo-local.sh test --lib --locked --offline commands::settings::tests -- --nocapture` | 6 passed; 65 unrelated tests filtered |
| Native watcher | Compile `src-tauri/tests/watch-backend.rs` with `rustc --test` against the current notify/log dependencies; run with `--test-threads=1` | 4 passed; 4,200 subscriptions added two macOS threads |
| Watcher formatting | `rustfmt --check --edition 2021` on watch.rs, watch_backend.rs and watch-backend.rs | Passed |
| Portable Cargo runner | `sh -n`, then locked offline `cargo metadata --no-deps` from both root and src-tauri | Passed |
| Whitespace | `git diff --check` | Passed |

## Existing full type-check failures

`node node_modules/typescript/bin/tsc --noEmit --pretty false` still exits with five
diagnostics. An independent temporary source tree extracted from upstream commit
`ad978652682270a593e7029269beff5411477a70` produced the same five diagnostics after
normalizing paths. There are no additional diagnostics in the working tree.

- `confirmDialog.ts:160`: Element is not assignable to HTMLElement.
- `modelsSection.ts:158` and `:159`: DropdownOption and createCustomDropdown are missing.
- `sidexChatService.ts:2070`: two diagnostics about the missing contextWindow property.

The full project type check has **not** passed.

## Build and runtime scope

No new full frontend or native app bundle was built for this cleanup. Before
removal, 27 source-file hashes and eight frontend-asset hashes matched the recorded
2026-10-27 build inputs and outputs. The existing production Worker passed the
runtime checks above. The Tauri settings test library was compiled during this run.

The installed `/Applications/SideX.app` was separate from the deleted build
directories and was left running. Its GUI interactions were not repeated during
this cleanup. Historical rollback archives and personal settings were retained
locally and excluded from Git.
