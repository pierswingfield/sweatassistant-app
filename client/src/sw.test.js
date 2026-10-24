import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const workerSource = fs.readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8');

function response(body = 'ok', init = {}) {
  return new Response(body, { status: 200, ...init });
}

function workerHarness({ fetchImpl, shell, failAdd = () => false, hangAdd = () => false, setTimeoutImpl = setTimeout } = {}) {
  const listeners = new Map();
  const entries = new Map(shell ? [['/index.html', shell]] : []);
  const puts = [];
  const added = [];
  const deleted = [];
  let skipped = false;
  const caches = {
    async open() {
      return {
        addAll: async () => {},
        add: async (asset) => { if (hangAdd(asset)) return new Promise(() => {}); if (failAdd(asset)) throw new TypeError(`fetch failed: ${asset}`); added.push(asset); },
        match: async (request) => entries.get(typeof request === 'string' ? request : new URL(request.url).pathname),
        put: async (request, value) => { puts.push([typeof request === 'string' ? request : new URL(request.url).pathname, value]); },
        keys: async () => [],
        delete: async (key) => { deleted.push(key); return true; },
      };
    },
    async match(request) {
      return entries.get(typeof request === 'string' ? request : new URL(request.url).pathname);
    },
    async keys() { return []; },
    async delete() { return true; },
  };
  const self = {
    location: { origin: 'https://app.test' },
    registration: { showNotification: async () => {} },
    clients: { claim: async () => {}, matchAll: async () => [] },
    skipWaiting: async () => { skipped = true; },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  class WorkerRequest extends Request {
    constructor(input, init) {
      super(typeof input === 'string' && input.startsWith('/') ? `https://app.test${input}` : input, init);
    }
  }
  vm.runInNewContext(workerSource, {
    self, caches, fetch: fetchImpl || (() => Promise.resolve(response())), Request: WorkerRequest, Response,
    URL, Promise, console, setTimeout: setTimeoutImpl, clearTimeout,
  });
  return {
    puts,
    added,
    deleted,
    get skipped() { return skipped; },
    async install() {
      let done;
      listeners.get('install')({ waitUntil(value) { done = value; } });
      await done;
    },
    dispatch(request) {
      let handled;
      listeners.get('fetch')({ request, respondWith(value) { handled = Promise.resolve(value); }, waitUntil() {} });
      return handled;
    },
  };
}

function navigation(path = '/timetable') {
  const request = new Request(`https://app.test${path}`, { headers: { accept: 'text/html' } });
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
}

describe('service-worker navigation shell', () => {
  it('returns a fast navigation and refreshes the cached shell', async () => {
    const fresh = response('<html>fresh</html>');
    const worker = workerHarness({ fetchImpl: async () => fresh });
    await expect(worker.dispatch(navigation())).resolves.toBe(fresh);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.puts).toHaveLength(1);
    expect(worker.puts[0][0]).toBe('/index.html');
  });

  it('uses a cached shell when navigation is offline', async () => {
    const shell = response('<html>cached</html>');
    const worker = workerHarness({ shell, fetchImpl: async () => { throw new TypeError('offline'); } });
    await expect(worker.dispatch(navigation('/bookings?day=2026-10-22'))).resolves.toBe(shell);
  });

  it('does not invent a shell when the navigation fails without a cache', async () => {
    const worker = workerHarness({ fetchImpl: async () => { throw new TypeError('offline'); } });
    await expect(worker.dispatch(navigation())).resolves.toBeUndefined();
  });

  it('does not intercept API, auth, or POST requests', () => {
    const worker = workerHarness();
    expect(worker.dispatch(new Request('https://app.test/api/my-gyms'))).toBeUndefined();
    expect(worker.dispatch(new Request('https://app.test/api/auth/login'))).toBeUndefined();
    expect(worker.dispatch(new Request('https://app.test/api/book', { method: 'POST', body: '{}' }))).toBeUndefined();
  });

  it('times out a hung navigation and serves its cached shell', async () => {
    const shell = response('<html>cached</html>');
    const worker = workerHarness({ shell, fetchImpl: () => new Promise(() => {}) });
    const result = await Promise.race([
      worker.dispatch(navigation()),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 900)),
    ]);
    expect(result).toBe(shell);
  });

  it('does not write a newer shell whose hashed chunk is absent from this generation', async () => {
    const worker = workerHarness({ fetchImpl: async () => response('<script src="/assets/new-build.js"></script>') });
    await worker.dispatch(navigation());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.puts).toEqual([]);
  });

  it('refreshes a coherent cached shell when the late network response eventually arrives', async () => {
    let resolveNetwork;
    const shell = response('<html>old</html>');
    const worker = workerHarness({ shell, fetchImpl: () => new Promise((resolve) => { resolveNetwork = resolve; }) });
    await expect(worker.dispatch(navigation())).resolves.toBe(shell);
    resolveNetwork(response('<html>new</html>'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.puts).toHaveLength(1);
    expect(await worker.puts[0][1].text()).toBe('<html>new</html>');
  });
});

describe('service worker install', () => {
  it('activates and keeps the shell when every precache asset loads', async () => {
    const worker = workerHarness({ fetchImpl: () => Promise.resolve(response()), shell: undefined, failAdd: () => false });
    await worker.install();
    expect(worker.skipped).toBe(true);
    expect(worker.added).toContain('/index.html');
    expect(worker.deleted).toEqual([]);
  });

  it('still activates when one asset fails, and drops the incoherent shell', async () => {
    const worker = workerHarness({ failAdd: (asset) => asset === '/favicon.ico' });
    await worker.install();
    expect(worker.skipped).toBe(true);
    expect(worker.deleted).toEqual(expect.arrayContaining(['/', '/index.html']));
  });

  it('still activates when a precache request hangs', async () => {
    const worker = workerHarness({
      hangAdd: (asset) => asset === '/favicon.ico',
      setTimeoutImpl: (fn, ms) => (ms >= 20000 ? setTimeout(fn, 0) : setTimeout(fn, ms)),
    });
    await worker.install();
    expect(worker.skipped).toBe(true);
    expect(worker.deleted).toEqual(expect.arrayContaining(['/', '/index.html']));
  });
});
