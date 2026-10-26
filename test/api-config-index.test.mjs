import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet } from '../functions/api/config/index.js';

test('GET /api/config rejects overlong search keywords before querying database', async () => {
  const request = new Request(`https://example.com/api/config?keyword=${'a'.repeat(101)}`);
  const env = {
    NAV_AUTH: {
      async get() {
        throw new Error('KV should not be queried for invalid keywords');
      },
    },
    NAV_DB: {
      prepare() {
        throw new Error('DB should not be queried for invalid keywords');
      },
    },
  };

  const response = await onRequestGet({ request, env });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, 400);
  assert.match(body.message, /搜索关键词不能超过 100 个字符/);
});

// 记录列表查询的绑定参数（最后两个即 LIMIT / OFFSET），count 查询固定返回 0 条
function createPaginationEnv({ sessionValue = null } = {}) {
  const listCalls = [];
  const env = {
    NAV_AUTH: {
      async get(key) {
        return key.startsWith('session_') ? sessionValue : null;
      },
    },
    NAV_DB: {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              async all() {
                listCalls.push({ sql, params });
                return { results: [] };
              },
              async first() {
                return { total: 0 };
              },
            };
          },
        };
      },
    },
  };
  return { env, listCalls };
}

test('GET /api/config caps pageSize at 200 for anonymous requests and echoes the effective value', async () => {
  const { env, listCalls } = createPaginationEnv();
  const request = new Request('https://example.com/api/config?pageSize=10000');

  const response = await onRequestGet({ request, env });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.pageSize, 200);
  assert.equal(listCalls.length, 1);
  const [limit, offset] = listCalls[0].params.slice(-2);
  assert.equal(limit, 200);
  assert.equal(offset, 0);
});

test('GET /api/config lets authenticated admins fetch up to 10000 rows per page', async () => {
  const { env, listCalls } = createPaginationEnv({ sessionValue: String(Date.now()) });
  const request = new Request('https://example.com/api/config?page=2&pageSize=99999', {
    headers: { Cookie: 'admin_session=test-token' },
  });

  const response = await onRequestGet({ request, env });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.page, 2);
  assert.equal(body.pageSize, 10000);
  assert.equal(listCalls.length, 1);
  // 认证必须先于分页解析，否则上限仍是 200；includePrivate 也应绑定为 1
  assert.equal(listCalls[0].params[0], 1);
  const [limit, offset] = listCalls[0].params.slice(-2);
  assert.equal(limit, 10000);
  assert.equal(offset, 10000);
});
