import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet } from '../functions/api/graph.js';
import { clearGraphCache } from '../functions/_middleware.js';

function createKv(initialEntries = {}) {
  const defaults = { session_test_token: 'admin' };
  const store = new Map(Object.entries(Object.assign(defaults, initialEntries)));
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function createGraphDb({
  sites = [],
  totalSites = sites.length,
  generation = null,
  generationStore = new Map(),
} = {}) {
  const calls = [];
  if (generation !== null) {
    generationStore.set('graph_cache_generation', generation);
  }

  return {
    calls,
    generationStore,
    prepare(sql) {
      const call = { sql, params: [] };
      calls.push(call);
      const statement = {
        bind(...params) {
          call.params = params;
          return statement;
        },
        async all() {
          if (sql.includes('FROM category') && !sql.includes('FROM sites')) {
            return {
              results: [
                { id: 1, catelog: '开发', parent_id: 0 },
                { id: 2, catelog: '设计', parent_id: 0 },
              ],
            };
          }
          return { results: sites };
        },
        async first() {
          if (sql.includes('SELECT value FROM settings WHERE key = ?')) {
            const value = generationStore.get(call.params[0]);
            return value === undefined ? null : { value };
          }
          if (sql.includes('COUNT(*)') && sql.includes('FROM category') && !sql.includes('FROM sites')) {
            return { total: 2 };
          }
          return { total: totalSites };
        },
        async run() {
          if (sql.includes('INSERT OR REPLACE INTO settings')) {
            generationStore.set(call.params[0], call.params[1]);
          }
          return { success: true };
        },
      };
      return statement;
    },
  };
}

function createContext(env, waitUntil = () => {}) {
  return {
    env,
    request: new Request('https://example.com/api/graph', {
      headers: { Cookie: 'admin_session=test_token' },
    }),
    waitUntil,
  };
}

test('graph cache generation prevents stale snapshots from being read after invalidation', async () => {
  const kv = createKv();
  const db = createGraphDb({
    generation: 'generation-1',
    sites: [{ id: 10, name: '旧书签', url: 'https://old.example', logo: '', catelog_id: 1 }],
  });
  const env = { NAV_AUTH: kv, NAV_DB: db };
  const pendingWrites = [];

  await onRequestGet(createContext(env, promise => pendingWrites.push(promise)));
  assert.equal(kv.store.has('graph_cache_generation-1'), true);

  await clearGraphCache(env);
  assert.notEqual(db.generationStore.get('graph_cache_generation'), 'generation-1');
  assert.equal(kv.store.has('graph_cache_generation'), false);

  db.prepare = createGraphDb({
    generationStore: db.generationStore,
    sites: [{ id: 11, name: '新书签', url: 'https://new.example', logo: '', catelog_id: 1 }],
  }).prepare;
  const response = await onRequestGet(createContext(env));
  const body = await response.json();

  assert.equal(response.headers.get('X-Cache'), 'MISS');
  assert.equal(body.data.nodes.some(node => node.title === '新书签'), true);
  assert.equal(body.data.nodes.some(node => node.title === '旧书签'), false);
  assert.equal(pendingWrites.length, 1);
});

test('graph site query is restricted to the categories included in the graph', async () => {
  const kv = createKv();
  const db = createGraphDb({
    generation: 'generation-1',
    sites: [{ id: 10, name: '开发书签', url: 'https://dev.example', logo: '', catelog_id: 1 }],
    totalSites: 1,
  });
  const env = { NAV_AUTH: kv, NAV_DB: db };

  const response = await onRequestGet(createContext(env));
  const body = await response.json();
  const siteQuery = db.calls.find(call => call.sql.includes('FROM sites s'));

  assert.equal(response.status, 200);
  assert.match(siteQuery.sql, /s\.catelog_id IN \(SELECT id FROM category/);
  assert.deepEqual(
    body.data.nodes.filter(node => node.kind === 'site').map(node => node.title),
    ['开发书签']
  );
});

test('graph categories include correct hierarchical level', async () => {
  const kv = createKv({ graph_cache_generation: 'gen-test' });
  const db = {
    calls: [],
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          if (sql.includes('FROM category')) {
            return {
              results: [
                { id: 1, catelog: '一级分类', parent_id: 0 },
                { id: 2, catelog: '二级分类', parent_id: 1 },
                { id: 3, catelog: '三级分类', parent_id: 2 },
                { id: 4, catelog: '四级分类', parent_id: 3 },
                { id: 5, catelog: '五级分类', parent_id: 4 },
                { id: 6, catelog: '六级分类', parent_id: 5 },
              ],
            };
          }
          return { results: [] };
        },
        async first() {
          return { total: 6 };
        },
      };
    },
  };
  const env = { NAV_AUTH: kv, NAV_DB: db };
  const response = await onRequestGet(createContext(env));
  const body = await response.json();
  const categoryNodes = body.data.nodes.filter(n => n.kind === 'category');

  assert.equal(categoryNodes.find(n => n.id === 'cat:1')?.level, 1);
  assert.equal(categoryNodes.find(n => n.id === 'cat:2')?.level, 2);
  assert.equal(categoryNodes.find(n => n.id === 'cat:3')?.level, 3);
  assert.equal(categoryNodes.find(n => n.id === 'cat:4')?.level, 4);
  assert.equal(categoryNodes.find(n => n.id === 'cat:5')?.level, 5);
  assert.equal(categoryNodes.find(n => n.id === 'cat:6')?.level, 6);
});

test('graph API requires admin authentication and returns 401 when unauthorized', async () => {
  const kv = createKv();
  const db = createGraphDb();
  const env = { NAV_AUTH: kv, NAV_DB: db };
  const unauthContext = {
    env,
    request: new Request('https://example.com/api/graph'),
    waitUntil: () => {},
  };

  const response = await onRequestGet(unauthContext);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.code, 401);
  assert.equal(body.message, 'Unauthorized');
});
