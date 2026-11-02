'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');

const helper = path.resolve(__dirname, '../extension-host/process-lifecycle.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidex-lifecycle-'));
const fixture = path.join(directory, 'fixture.cjs');
fs.writeFileSync(fixture, `
const cp = require('node:child_process');
const { installProcessCleanup } = require(${JSON.stringify(helper)});
const mode = process.argv[2];
if (mode === 'delayed-ps') {
  const spawnSync = cp.spawnSync;
  cp.spawnSync = (command, ...args) => {
    if (command === 'ps') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
    return spawnSync(command, ...args);
  };
}
if (mode === 'leaf') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'branch') {
  const leaf = cp.spawn(process.execPath, [__filename, 'leaf'], { detached: true, stdio: 'ignore' });
  process.on('SIGTERM', () => {});
  process.send({ leaf: leaf.pid });
  setInterval(() => {}, 1000);
} else {
  let branch;
  installProcessCleanup(() => branch?.kill('SIGTERM'), { stdin: true, ipc: true });
  // Match the old host's exception logger: an EPIPE must not re-enter it.
  process.on('uncaughtException', error => process.stderr.write(error.stack));
  branch = cp.fork(__filename, ['branch'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  branch.once('message', message => process.send({ branch: branch.pid, leaf: message.leaf }));
  process.on('message', message => {
    if (message === 'break-pipe') process.stderr.write(Buffer.alloc(256 * 1024, 120));
  });
}
`);

function alive(pid) {
  if (process.platform !== 'win32') {
    const status = cp.spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
    return status.status === 0 && status.stdout.trim() !== '' && !status.stdout.trim().startsWith('Z');
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitUntil(check, description) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('extension-host cleanup removes children and detached grandchildren without touching unrelated Node processes', async t => {
  const sentinel = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const triggers = ['stdin EOF', 'IPC disconnect', 'SIGTERM', 'broken stderr pipe'];
    if (process.platform !== 'win32') triggers.push('delayed ps with Rust deadline');
    for (const trigger of triggers) {
      await t.test(trigger, async () => {
        const delayed = trigger === 'delayed ps with Rust deadline';
        const host = cp.fork(fixture, [delayed ? 'delayed-ps' : 'host'], {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          detached: delayed,
        });
        let children;
        let groupFallback;
        try {
          [children] = await Promise.race([
            once(host, 'message'),
            new Promise((_, reject) => setTimeout(() => reject(Error('fixture readiness timed out')), 5000).unref()),
          ]);
          const exited = once(host, 'exit');
          const started = Date.now();
          if (delayed) {
            // Exercise the same fallback deadline as Rust, including its own
            // process group. Reading the production value catches regressions
            // to a grace period shorter than Node's synchronous cleanup.
            const rust = fs.readFileSync(path.join(__dirname, '../src/commands/ext_host.rs'), 'utf8');
            const deadline = /let deadline = Instant::now\(\) \+ Duration::from_millis\(([\d_]+)\)/.exec(rust);
            assert.ok(deadline, 'Rust shutdown deadline is available to the fixture');
            groupFallback = setTimeout(() => {
              try { process.kill(-host.pid, 'SIGKILL'); } catch {}
            }, Number(deadline[1].replaceAll('_', '')));
            host.stdin.end();
          } else if (trigger === 'stdin EOF') host.stdin.end();
          else if (trigger === 'IPC disconnect') host.disconnect();
          else if (trigger === 'SIGTERM') host.kill('SIGTERM');
          else {
            host.stderr.destroy();
            await once(host.stderr, 'close');
            host.send('break-pipe');
          }
          const [code, signal] = await Promise.race([
            exited,
            new Promise((_, reject) => setTimeout(() => reject(Error('host exit timed out')), 5000).unref()),
          ]);
          if (delayed) {
            assert.equal(signal, null, 'cleanup finishes before Rust forcibly kills its process group');
            assert.equal(code, 0);
            assert.ok(Date.now() - started >= 1000, 'both process snapshots were delayed beyond the old 500ms budget');
          }
          await waitUntil(() => !alive(children.branch) && !alive(children.leaf), 'all fixture descendants must exit');
          assert.equal(alive(sentinel.pid), true, 'unrelated Node process remains alive');
        } finally {
          clearTimeout(groupFallback);
          for (const pid of [children?.leaf, children?.branch, host.pid].filter(Boolean)) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        }
      });
    }
  } finally {
    sentinel.kill('SIGKILL');
    await once(sentinel, 'exit');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
