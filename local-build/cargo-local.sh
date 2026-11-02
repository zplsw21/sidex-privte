#!/bin/sh
set -eu
# Avoid the obsolete registry mirror in this machine's ancestor Cargo config.
manifest_dir=$PWD
subcommand=$1
shift
export CARGO_HOME="${SIDEX_CARGO_HOME:-${HOME}/.cache/sidex-cargo}"
cd /tmp
exec cargo "$subcommand" --manifest-path "$manifest_dir/Cargo.toml" "$@"
