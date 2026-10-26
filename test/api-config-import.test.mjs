import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost } from '../functions/api/config/import.js';

function createKv(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

test('import override updates the database URL form that actually exists', async () => {
  const runCalls = [];
  const db = {
    prepare(sql) {
      const createStatement = (params = []) => ({
        async all() {
          if (sql.includes('SELECT id, catelog, parent_id, is_private FROM category')) {
            return { results: [{ id: 1, catelog: 'Default', parent_id: 0, is_private: 0 }] };
          }
          if (sql.includes('SELECT url FROM sites WHERE url IN')) {
            return { results: [{ url: 'https://example.com' }] };
          }
          throw new Error(`Unexpected all() SQL: ${sql} ${JSON.stringify(params)}`);
        },
        async run() {
          runCalls.push({ sql, params });
          return { success: true, meta: {} };
        },
      });

      return {
        bind(...params) {
          return createStatement(params);
        },
        all: createStatement().all,
        run: createStatement().run,
      };
    },
    async batch(statements) {
      for (const statement of statements) {
        await statement.run();
      }
    },
  };

  const request = new Request('https://example.com/api/config/import', {
    method: 'POST',
    headers: {
      Cookie: 'admin_session=token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      override: true,
      category: [{ id: 1, catelog: 'Default', parent_id: 0, is_private: 0 }],
      sites: [{
        name: 'Updated',
        url: 'https://example.com',
        catelog_id: 1,
        sort_order: 1,
      }],
    }),
  });

  const env = {
    NAV_AUTH: createKv({ session_token: '1' }),
    NAV_DB: db,
  };

  const response = await onRequestPost({ request, env });
  const body = await response.json();
  const updateCall = runCalls.find(call => call.sql.includes('UPDATE sites SET'));

  assert.equal(response.status, 201, body.message);
  assert.match(body.message, /更新 1 个/);
  assert.ok(updateCall);
  assert.equal(updateCall.params.at(-1), 'https://example.com');
});
