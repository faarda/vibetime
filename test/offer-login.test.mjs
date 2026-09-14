import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'vibe-offer-login-'));
process.env.VIBE_DIR = scratch;
delete process.env.VIBE_SESSION;

// Any attempt to actually start the device flow hits this and is counted, so a
// test can prove the offer did NOT proceed to login.
let githubCalls = 0;
const server = createServer((req, res) => {
  githubCalls++;
  res.statusCode = 500;
  res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.VIBE_API = `http://127.0.0.1:${server.address().port}`;
// Without this the device flow would call real github and poll it for fifteen
// minutes, which is exactly how this file first hung.
process.env.VIBE_GITHUB_BASE = `http://127.0.0.1:${server.address().port}`;

const { offerLogin, AUTH_PATH } = await import('../dist/auth.js');

function tty(answer) {
  const s = new PassThrough();
  s.isTTY = true;
  setImmediate(() => s.write(answer));
  return s;
}

test('a non-interactive run never prompts and never blocks', async () => {
  rmSync(AUTH_PATH, { force: true });
  const piped = new PassThrough(); // isTTY undefined, like a script or CI
  const before = githubCalls;

  await offerLogin(piped);

  assert.equal(githubCalls, before, 'must not reach out to github');
  assert.equal(existsSync(AUTH_PATH), false);
});

test('answering no skips login and leaves tracking working', async () => {
  rmSync(AUTH_PATH, { force: true });
  const before = githubCalls;

  await offerLogin(tty('n\n'));

  assert.equal(githubCalls, before, 'no must mean no');
  assert.equal(existsSync(AUTH_PATH), false, 'nothing written, so no account');
});

test('an existing login is not asked again', async () => {
  writeFileSync(AUTH_PATH, JSON.stringify({ jwt: 'a.b.c', handle: 't', avatarUrl: null, issuedAt: new Date().toISOString() }));
  const before = githubCalls;

  await offerLogin(tty('y\n'));

  assert.equal(githubCalls, before, 'already signed in, so nothing to do');
});

test('a signed-out record is not re-offered here either', async () => {
  // The endcard already tells these users to run vibe login; setup should not
  // ambush them a second time.
  writeFileSync(AUTH_PATH, JSON.stringify({ jwt: '', handle: 't', avatarUrl: null, issuedAt: new Date().toISOString(), signedOutAt: new Date().toISOString() }));
  const before = githubCalls;

  await offerLogin(tty('y\n'));

  assert.equal(githubCalls, before);
});

test('yes starts the device flow', async () => {
  rmSync(AUTH_PATH, { force: true });
  const before = githubCalls;

  // The stub returns 500 so login() gives up immediately instead of polling.
  await offerLogin(tty('\n')); // bare enter, the default

  assert.ok(githubCalls > before, 'enter should mean yes');
  assert.equal(existsSync(AUTH_PATH), false, 'and a failed login writes nothing');
});

test.after(() => server.close());
