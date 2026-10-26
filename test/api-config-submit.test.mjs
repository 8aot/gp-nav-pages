import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost } from '../functions/api/config/submit.js';

function createKv(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

test('public submit does not expose duplicate site URL existence', async () => {
  const runCalls = [];
  const firstSqlCalls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              firstSqlCalls.push(sql);
              if (sql.includes('SELECT catelog, is_private FROM category')) {
                return { catelog: 'Public', is_private: 0 };
              }
              throw new Error(`Unexpected first() SQL: ${sql} ${JSON.stringify(params)}`);
            },
            async run() {
              runCalls.push({ sql, params });
              return { success: true };
            },
          };
        },
      };
    },
  };

  const request = new Request('https://example.com/api/config/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://example.com',
      'CF-Connecting-IP': '203.0.113.1',
    },
    body: JSON.stringify({
      name: 'Submitted',
      url: 'https://private.example.com',
      catelog_id: 1,
    }),
  });

  const env = {
    ENABLE_PUBLIC_SUBMISSION: 'true',
    NAV_AUTH: createKv(),
    NAV_DB: db,
  };

  const response = await onRequestPost({ request, env });
  const body = await response.json();

  assert.equal(response.status, 201, body.message);
  assert.match(body.message, /waiting for admin approve/);
  assert.equal(firstSqlCalls.some(sql => sql.includes('FROM sites')), false);
  assert.equal(firstSqlCalls.some(sql => sql.includes('FROM pending_sites')), false);
  const insertCall = runCalls.find(call => call.sql.includes('INSERT INTO pending_sites'));
  assert.ok(insertCall);
  assert.equal(insertCall.params[1], 'https://private.example.com');
});
