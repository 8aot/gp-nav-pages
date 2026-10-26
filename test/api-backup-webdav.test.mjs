import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost, onRequestGet, onRequestDelete } from '../functions/api/backup/webdav.js';
import { INPUT_LIMITS, IMPORT_BODY_MAX_BYTES } from '../functions/lib/validators.js';

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
    async delete(key) {
      store.delete(key);
    },
  };
}

function createDb({ settings = {}, sites = [], categories = [] } = {}) {
  return {
    prepare(sql) {
      const makeStatement = (params = []) => ({
        async all() {
          if (sql.includes('SELECT key, value FROM settings WHERE key IN')) {
            return {
              results: params
                .filter(key => settings[key] !== undefined)
                .map(key => ({ key, value: settings[key] })),
            };
          }
          if (sql.includes('FROM sites')) {
            return { results: sites };
          }
          if (sql.includes('FROM category')) {
            return { results: categories };
          }
          return { results: [] };
        },
      });
      return {
        bind(...params) {
          return makeStatement(params);
        },
        // fetchBookmarkExport 不带参数，直接 prepare(...).all()
        all: makeStatement().all,
      };
    },
  };
}

function buildRequest() {
  return new Request('https://example.com/api/backup/webdav', {
    method: 'POST',
    headers: { Cookie: 'admin_session=token' },
  });
}

const SAMPLE_DATA = {
  sites: [
    { id: 1, name: '公开站', url: 'https://public.example.com', catelog_id: 1, is_private: 0 },
    { id: 2, name: '私密站', url: 'https://private.example.com', catelog_id: 2, is_private: 1 },
  ],
  categories: [
    { id: 1, catelog: '公开分类', parent_id: 0, is_private: 0 },
    { id: 2, catelog: '私密分类', parent_id: 0, is_private: 1 },
  ],
};

function stubFetchOnce(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(calls, url, init);
  };
  return calls;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function buildGetRequest(query = '') {
  return new Request(`https://example.com/api/backup/webdav${query}`, {
    method: 'GET',
    headers: { Cookie: 'admin_session=token' },
  });
}

function buildDeleteRequest(filename) {
  return new Request(`https://example.com/api/backup/webdav?filename=${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: { Cookie: 'admin_session=token' },
  });
}

const PROPFIND_XML = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/nav/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/nav/iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json</D:href>
    <D:propstat><D:prop>
      <D:getcontentlength>2048</D:getcontentlength>
      <D:getlastmodified>Thu, 01 Jan 2026 10:15:00 GMT</D:getlastmodified>
    </D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/nav/iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json</D:href>
    <D:propstat><D:prop><D:getcontentlength>4096</D:getcontentlength></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/nav/unrelated-note.txt</D:href>
    <D:propstat><D:prop><D:getcontentlength>10</D:getcontentlength></D:prop></D:propstat>
  </D:response>
</D:multistatus>`;

test('POST /api/backup/webdav rejects unauthenticated requests', async () => {
  const request = new Request('https://example.com/api/backup/webdav', { method: 'POST' });
  const response = await onRequestPost({
    request,
    env: { NAV_AUTH: createKv(), NAV_DB: createDb() },
  });
  assert.equal(response.status, 401);
});

test('POST /api/backup/webdav returns 400 when WebDAV is not configured', async () => {
  const kv = createKv({ session_token: '1' });
  const response = await onRequestPost({
    request: buildRequest(),
    env: { NAV_AUTH: kv, NAV_DB: createDb() },
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.message, /WebDAV 未配置/);
});

// 只缺密码时不能提「地址」：多标签页里另一个标签清了密码，本标签地址还填着，
// 合成一条提示会让用户对着已填好的地址排查
test('POST /api/backup/webdav names only the missing field', async () => {
  const kv = createKv({ session_token: '1' });
  const response = await onRequestPost({
    request: buildRequest(),
    env: {
      NAV_AUTH: kv,
      NAV_DB: createDb({ settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'user' } }),
    },
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.message, /密码/);
  assert.doesNotMatch(body.message, /地址/);
});

test('POST /api/backup/webdav uploads full bookmarks including private ones', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'user', webdav_password: 'secret', webdav_dir: 'iori-nav' },
    sites: SAMPLE_DATA.sites,
    categories: SAMPLE_DATA.categories,
  });

  const calls = stubFetchOnce(() => jsonResponse(201, { ok: true }));

  const response = await onRequestPost({
    request: buildRequest(),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(body.code, 200);
  assert.equal(calls.length, 1);

  const { url, init } = calls[0];
  assert.equal(init.method, 'PUT');
  assert.match(url, /^https:\/\/dav\.example\.com\/iori-nav\/iori-nav-backup-\d{8}-\d{6}-\d{3}-[0-9a-f]{32}\.json$/);
  assert.equal(init.headers.Authorization, `Basic ${btoa('user:secret')}`);

  const uploaded = JSON.parse(init.body);
  assert.equal(uploaded.sites.length, 2);
  assert.equal(uploaded.category.length, 2);
  assert.ok(uploaded.sites.some(s => s.is_private === 1), '私密书签应包含在备份中');
});

test('POST /api/backup/webdav accepts a restorable category-only backup', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_password: 'secret' },
    categories: [{ id: 1, catelog: '空分类', parent_id: 0, is_private: 0 }],
    sites: [],
  });
  const calls = stubFetchOnce(() => jsonResponse(201, {}));

  const response = await onRequestPost({ request: buildRequest(), env: { NAV_AUTH: kv, NAV_DB: db } });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body).sites, []);
});

test('POST /api/backup/webdav rejects legacy rows that the importer would skip', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_password: 'secret' },
    categories: [{ id: 1, catelog: '默认', parent_id: 0 }],
    sites: [{
      id: 1,
      name: '旧书签',
      url: 'https://legacy.example.com',
      desc: 'x'.repeat(INPUT_LIMITS.bookmarkDesc + 1),
      catelog_id: 1,
    }],
  });
  let fetched = false;
  stubFetchOnce(() => {
    fetched = true;
    return jsonResponse(201, {});
  });

  const response = await onRequestPost({ request: buildRequest(), env: { NAV_AUTH: kv, NAV_DB: db } });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.match(body.message, /描述不能超过/);
  assert.equal(fetched, false, '会被恢复器跳过的数据不应上传');
});

test('POST /api/backup/webdav names the bookmark that exceeds the name limit', async () => {
  const kv = createKv({ session_token: '1' });
  const longName = `超长书签-${'长'.repeat(INPUT_LIMITS.bookmarkName)}`;
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_password: 'secret' },
    categories: [{ id: 1, catelog: '默认', parent_id: 0 }],
    sites: [{
      id: 1,
      name: longName,
      url: 'https://legacy.example.com',
      catelog_id: 1,
    }],
  });
  let fetched = false;
  stubFetchOnce(() => {
    fetched = true;
    return jsonResponse(201, {});
  });

  const response = await onRequestPost({ request: buildRequest(), env: { NAV_AUTH: kv, NAV_DB: db } });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.ok(body.message.includes(`第 1 个书签「${longName}」`), body.message);
  assert.match(body.message, /书签名称不能超过 120 个字符/);
  assert.equal(fetched, false, '不可恢复的数据不应上传为成功备份');
});

test('POST /api/backup/webdav refuses backups that the importer cannot restore', async () => {
  const kv = createKv({ session_token: '1' });
  const sites = Array.from({ length: INPUT_LIMITS.importSites + 1 }, (_, i) => ({
    id: i + 1,
    name: `站点 ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    catelog_id: 1,
  }));
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_password: 'secret' },
    sites,
    categories: [{ id: 1, catelog: '默认', parent_id: 0 }],
  });
  let fetched = false;
  stubFetchOnce(() => {
    fetched = true;
    return jsonResponse(201, {});
  });

  const response = await onRequestPost({ request: buildRequest(), env: { NAV_AUTH: kv, NAV_DB: db } });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.match(body.message, /10000/);
  assert.equal(fetched, false, '不可恢复的数据不应上传为成功备份');
});

test('POST /api/backup/webdav creates missing directory via MKCOL then retries PUT', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'user', webdav_password: 'secret', webdav_dir: 'iori-nav/sub' },
    sites: SAMPLE_DATA.sites,
    categories: SAMPLE_DATA.categories,
  });

  let putCount = 0;
  const calls = stubFetchOnce((calls, url, init) => {
    if (init.method === 'PUT') {
      putCount += 1;
      if (putCount === 1) return jsonResponse(409, { message: 'dir missing' });
      return jsonResponse(201, { ok: true });
    }
    if (init.method === 'MKCOL') {
      if (String(url).endsWith('/iori-nav/')) return jsonResponse(405, {});
      if (String(url).endsWith('/iori-nav/sub/')) return jsonResponse(201, {});
    }
    return jsonResponse(500, {});
  });

  const response = await onRequestPost({
    request: buildRequest(),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(putCount, 2);
  const mkcolCalls = calls.filter(c => c.init.method === 'MKCOL');
  assert.equal(mkcolCalls.length, 2);
  assert.equal(mkcolCalls[0].url, 'https://dav.example.com/iori-nav/');
  assert.equal(mkcolCalls[1].url, 'https://dav.example.com/iori-nav/sub/');
});

test('POST /api/backup/webdav surfaces WebDAV auth errors', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'user', webdav_password: 'wrong' },
    sites: SAMPLE_DATA.sites,
    categories: SAMPLE_DATA.categories,
  });

  stubFetchOnce(() => jsonResponse(401, { message: 'unauthorized' }));

  const response = await onRequestPost({
    request: buildRequest(),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.match(body.message, /认证失败/);
});

test('WebDAV requests never follow redirects with credentials attached', async () => {
  // 每个请求都带 Basic 凭据，跟随 30x 就可能把账号密码发给 Location 指向的主机
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'user', webdav_password: 'secret' },
    sites: SAMPLE_DATA.sites,
    categories: SAMPLE_DATA.categories,
  });

  const calls = stubFetchOnce(() => new Response(null, {
    status: 302,
    headers: { Location: 'https://attacker.example/steal' },
  }));

  const response = await onRequestPost({
    request: buildRequest(),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const body = await response.json();

  assert.equal(calls.length, 1, '不应再向重定向目标发第二次请求');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(response.status, 502);
  assert.match(body.message, /重定向/);
  assert.equal(JSON.stringify(body).includes('secret'), false, '错误信息不得回显密码');
});

test('POST /api/backup/webdav reports which directory level MKCOL failed on', async () => {
  // 中间层失败时若只回 false，用户看到的是 PUT 的 409，
  // 会对着「目录不存在」排查，而真实原因是某一层没有写权限
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: {
      webdav_url: 'https://dav.example.com/',
      webdav_username: 'user',
      webdav_password: 'secret',
      webdav_dir: 'iori-nav/sub',
    },
    sites: SAMPLE_DATA.sites,
    categories: SAMPLE_DATA.categories,
  });

  let putCount = 0;
  const calls = stubFetchOnce((_calls, url, init) => {
    if (init.method === 'PUT') {
      putCount += 1;
      return jsonResponse(409, { message: 'dir missing' });
    }
    if (init.method === 'MKCOL') {
      if (String(url).endsWith('/iori-nav/')) return jsonResponse(201, {});
      // 第二层没权限
      if (String(url).endsWith('/iori-nav/sub/')) return jsonResponse(403, {});
    }
    return jsonResponse(500, {});
  });

  const response = await onRequestPost({
    request: buildRequest(),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const body = await response.json();

  assert.equal(putCount, 1, '目录没建成就不该重试 PUT');
  assert.equal(calls.filter(c => c.init.method === 'MKCOL').length, 2);
  assert.match(body.message, /iori-nav\/sub/, '应指出失败的层级');
  assert.match(body.message, /403/, '应透出真实状态码而不是 PUT 的 409');
});

test('GET /api/backup/webdav rejects unauthenticated requests', async () => {
  const response = await onRequestGet({
    request: new Request('https://example.com/api/backup/webdav', { method: 'GET' }),
    env: { NAV_AUTH: createKv(), NAV_DB: createDb() },
  });
  assert.equal(response.status, 401);
});

test('GET /api/backup/webdav lists the 10 most recent backups', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'u', webdav_password: 'p', webdav_dir: 'nav' },
  });

  const calls = stubFetchOnce(() => new Response(PROPFIND_XML, { status: 207 }));

  const response = await onRequestGet({ request: buildGetRequest('?limit=10'), env: { NAV_AUTH: kv, NAV_DB: db } });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls[0].init.method, 'PROPFIND');
  assert.equal(calls[0].init.headers.Depth, '1');
  assert.equal(body.data.backups.length, 2);
  assert.equal(body.data.backups[0].filename, 'iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json');
  assert.equal(body.data.backups[0].backupTime, '2026-02-02T08:00:00.000Z');
});

test('GET /api/backup/webdav?filename downloads and returns bookmark payload', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'u', webdav_password: 'p', webdav_dir: 'nav' },
  });

  const payload = { category: [{ id: 1, catelog: '分类' }], sites: [{ id: 1, name: '站', url: 'https://a.com', catelog_id: 1 }] };
  const calls = stubFetchOnce(() => new Response(JSON.stringify(payload), { status: 200 }));

  const response = await onRequestGet({
    request: buildGetRequest('?filename=iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json'),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls[0].init.method, 'GET');
  assert.match(calls[0].url, /iori-nav-backup-20260202-080000-000-[0-9a-f]{32}\.json$/);
  assert.equal(body.data.sites.length, 1);
  assert.equal(body.data.category.length, 1);
});

test('GET /api/backup/webdav rejects legacy backups beyond the importer limit', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'u', webdav_password: 'p' },
  });
  const payload = {
    category: [],
    sites: Array.from({ length: INPUT_LIMITS.importSites + 1 }, () => ({})),
  };
  stubFetchOnce(() => new Response(JSON.stringify(payload), { status: 200 }));

  const response = await onRequestGet({
    request: buildGetRequest('?filename=iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json'),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.match(body.message, /10000/);
});

test('GET /api/backup/webdav rejects an oversized download before buffering it', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'u', webdav_password: 'p' },
  });

  // 服务端不给 Content-Length（chunked），只能边读边计数
  let bytesProduced = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const body = new ReadableStream({
    pull(controller) {
      bytesProduced += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  stubFetchOnce(() => new Response(body, { status: 200 }));

  const response = await onRequestGet({
    request: buildGetRequest('?filename=iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json'),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const responseBody = await response.json();

  // 上限生效于读取过程，不是读完之后
  assert.equal(response.status, 413);
  assert.match(responseBody.message, /10MB 恢复上限/);
  // 流是无限的，能返回就证明读取被中断了；余量放宽到几个 chunk，
  // 不依赖 ReadableStream 内部队列预取多少
  assert.ok(
    bytesProduced <= IMPORT_BODY_MAX_BYTES + 4 * chunk.byteLength,
    `超限后应立刻 cancel，实际读入 ${bytesProduced} 字节`
  );
});

test('GET /api/backup/webdav caps an oversized PROPFIND listing', async () => {
  // 列表响应同样是外部服务器控制的，不能裸 res.text() 全量读进来
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'u', webdav_password: 'p' },
  });

  let bytesProduced = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const body = new ReadableStream({
    pull(controller) {
      bytesProduced += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  stubFetchOnce(() => new Response(body, { status: 207 }));

  const response = await onRequestGet({
    request: buildGetRequest('?limit=10'),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const responseBody = await response.json();

  assert.equal(response.status, 413);
  assert.match(responseBody.message, /5MB/);
  assert.ok(
    bytesProduced <= 5 * 1024 * 1024 + 4 * chunk.byteLength,
    `超限后应立刻 cancel，实际读入 ${bytesProduced} 字节`
  );
});

test('GET /api/backup/webdav rejects an oversized download declared via Content-Length', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'u', webdav_password: 'p' },
  });

  let bodyRead = false;
  stubFetchOnce(() => {
    const res = new Response('{}', {
      status: 200,
      headers: { 'Content-Length': String(IMPORT_BODY_MAX_BYTES + 1) },
    });
    // 声明超限时不应该去碰响应体
    Object.defineProperty(res, 'body', {
      get() {
        bodyRead = true;
        return null;
      },
    });
    return res;
  });

  const response = await onRequestGet({
    request: buildGetRequest('?filename=iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json'),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const responseBody = await response.json();

  assert.equal(response.status, 413);
  assert.match(responseBody.message, /10MB 恢复上限/);
  assert.equal(bodyRead, false, '声明的 Content-Length 超限时不应读取响应体');
});

test('GET /api/backup/webdav rejects filenames outside the backup pattern', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'u', webdav_password: 'p' },
  });

  let fetched = false;
  stubFetchOnce(() => { fetched = true; return new Response('{}', { status: 200 }); });

  const response = await onRequestGet({
    request: buildGetRequest('?filename=../../etc/passwd'),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });

  assert.equal(response.status, 400);
  assert.equal(fetched, false, '非法文件名不应发出任何网络请求');
});

test('DELETE /api/backup/webdav deletes the selected backup', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: { webdav_url: 'https://dav.example.com/', webdav_username: 'u', webdav_password: 'p', webdav_dir: 'nav' },
  });
  const filename = 'iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json';
  const calls = stubFetchOnce(() => new Response(null, { status: 204 }));

  const response = await onRequestDelete({
    request: buildDeleteRequest(filename),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const body = await response.json();

  assert.equal(response.status, 200, body.message);
  assert.equal(body.data.filename, filename);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].url, `https://dav.example.com/nav/${filename}`);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('DELETE /api/backup/webdav rejects unauthenticated and invalid filenames before WebDAV fetch', async () => {
  const filename = 'iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json';
  const unauthenticated = await onRequestDelete({
    request: new Request(`https://example.com/api/backup/webdav?filename=${filename}`, { method: 'DELETE' }),
    env: { NAV_AUTH: createKv(), NAV_DB: createDb() },
  });
  assert.equal(unauthenticated.status, 401);

  let fetched = false;
  stubFetchOnce(() => {
    fetched = true;
    return new Response(null, { status: 204 });
  });
  const invalid = await onRequestDelete({
    request: buildDeleteRequest('../../other.json'),
    env: {
      NAV_AUTH: createKv({ session_token: '1' }),
      NAV_DB: createDb({ settings: { webdav_url: 'https://dav.example.com/', webdav_password: 'p' } }),
    },
  });

  assert.equal(invalid.status, 400);
  assert.equal(fetched, false, '非法文件名不应触发 WebDAV DELETE');
});

test('DELETE /api/backup/webdav reports a backup already removed remotely', async () => {
  const filename = 'iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json';
  stubFetchOnce(() => new Response(null, { status: 404 }));

  const response = await onRequestDelete({
    request: buildDeleteRequest(filename),
    env: {
      NAV_AUTH: createKv({ session_token: '1' }),
      NAV_DB: createDb({ settings: { webdav_url: 'https://dav.example.com/', webdav_password: 'p' } }),
    },
  });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.match(body.message, /不存在或已被删除/);
});

test('POST /api/backup/webdav supports non-ASCII credentials', async () => {
  const kv = createKv({ session_token: '1' });
  const db = createDb({
    settings: {
      webdav_url: 'https://dav.example.com/',
      webdav_username: '张三',
      webdav_password: '应用授权码',
      webdav_dir: 'iori-nav',
    },
    sites: SAMPLE_DATA.sites,
    categories: SAMPLE_DATA.categories,
  });

  const calls = stubFetchOnce(() => jsonResponse(201, { ok: true }));

  const response = await onRequestPost({
    request: buildRequest(),
    env: { NAV_AUTH: kv, NAV_DB: db },
  });
  const body = await response.json();

  // btoa 只接受 Latin-1，中文凭据必须先转 UTF-8 字节，否则这里会是 500
  assert.equal(response.status, 200, body.message);
  assert.equal(calls.length, 1);

  const header = calls[0].init.headers.Authorization;
  const decoded = new TextDecoder().decode(Buffer.from(header.replace('Basic ', ''), 'base64'));
  assert.equal(decoded, '张三:应用授权码', 'WebDAV 服务端应能解回原始凭据');
});
