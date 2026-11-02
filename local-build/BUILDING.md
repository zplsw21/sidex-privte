# Local SideX build and Thief-Book extension

This directory keeps the local macOS build configuration, the Thief-Book adaptation,
and its verification scripts. `thief-book/out/*.js` is the extension's source and must
be retained. Generated runtimes, archives, personal settings and historical build
records are excluded by `.gitignore`.

## Prerequisites and setup

Use the Rust version required by `Cargo.toml`, Xcode Command Line Tools, Node.js 24
or newer, npm and Python 3. The bridge verification scripts use
`module.stripTypeScriptTypes`.

From the repository root:

```sh
npm ci
npm run setup:full
```

`setup:full` prepares built-in extensions from a local VS Code installation; see
`scripts/setup-extensions.sh` for supported locations. `npm run setup` only generates
metadata and does not restore the `extensions/` directory.

For the native app, place a matching macOS Node executable at
`local-build/node/bin/node`. This binary is not committed and `npm ci` does not
create it. The local Tauri configuration bundles it with the extension resources.

## Build

Run from the repository root:

```sh
node_modules/.bin/tauri build --debug --bundles app \
  --config "$PWD/local-build/tauri.local.json" \
  --runner "$PWD/local-build/cargo-local.sh" --ci
```

The app is generated at `target/debug/bundle/macos/SideX.app`. This local build uses
ad-hoc signing and does not generate updater artifacts. Install it only after
quitting the running app; build output and `/Applications/SideX.app` are separate.

`cargo-local.sh` uses `~/.cache/sidex-cargo` by default and runs Cargo from `/tmp`
to avoid inherited registry configuration. Override the cache with
`SIDEX_CARGO_HOME`. Run it from the directory containing the intended `Cargo.toml`;
Tauri sets that directory to `src-tauri`.

## Verify and package

Run from the repository root:

```sh
node --test src-tauri/tests/*.test.cjs
npm --prefix local-build/thief-book test
node --test scripts/test-worker-lifecycle.mjs
node --experimental-vm-modules scripts/test-worker-nls.mjs
node local-build/verify-host.cjs
node local-build/verify-keybindings.cjs
node local-build/verify-local-extension-resources.cjs
node local-build/verify-esm-shim.cjs
./local-build/cargo-local.sh test -p sidex-settings --locked
python3 local-build/package-extension.py
```

After building the frontend with `npm run build`, also run:

```sh
node --experimental-vm-modules scripts/test-built-editor-worker.mjs
```

The extension package is written to `local-build/thief-book-sidex-<version>.vsix`.
It can be installed using SideX's **Extensions: Install from VSIX...** command.
Back up existing extension state before replacing an installed extension directory.

## Disposable files

`target/`, `src-tauri/target/`, `src-tauri/gen/`, `dist/`, and generated extension
metadata can be regenerated. `node_modules/` can be restored with `npm ci`.
Keep `extensions/`, local build tools, and `thief-book/out/` when cleaning caches.
