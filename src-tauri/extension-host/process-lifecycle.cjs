'use strict';

const cp = require('child_process');

function isBrokenPipe(error) {
  return error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED';
}

// Snapshot ancestry before terminating a parent: once it exits, its children
// are reparented and can no longer be identified as belonging to this host.
function descendantPids(pid) {
  const result = cp.spawnSync('ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  const children = new Map();
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const child = Number(match[1]);
    const parent = Number(match[2]);
    if (child === result.pid) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const descendants = [];
  const visit = (parent) => {
    for (const child of children.get(parent) || []) {
      visit(child);
      descendants.push(child);
    }
  };
  visit(pid);
  return descendants;
}

function installProcessCleanup(onShutdown, { stdin = false, ipc = false } = {}) {
  let stopping = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    const descendants = process.platform === 'win32' ? [] : descendantPids(process.pid);
    try { onShutdown(); } catch {}
    if (process.platform === 'win32') {
      // The PID is this process, never an executable name shared with other apps.
      cp.spawnSync('taskkill', ['/PID', String(process.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 2000,
        stdio: 'ignore',
      });
    } else {
      const pids = new Set([...descendantPids(process.pid), ...descendants]);
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  };
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // exit also handles an extension calling process.exit() directly.
    process.exit(0);
  };
  process.once('exit', cleanup);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  if (ipc) process.once('disconnect', shutdown);
  if (stdin) {
    process.stdin.once('end', shutdown);
    process.stdin.resume();
  }
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error) => {
      // Logging a broken pipe as an uncaught exception writes to the same
      // broken pipe again, causing an unbounded exception/CPU loop.
      if (isBrokenPipe(error)) shutdown();
    });
  }
  return shutdown;
}

module.exports = { descendantPids, installProcessCleanup, isBrokenPipe };
