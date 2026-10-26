import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBackupFilename, parseBackupFilename, selectRecentBackups } from '../functions/api/backup/webdav.js';
import { parsePropfindEntries, buildWebdavUrl } from '../functions/lib/webdav-client.js';
import { listWebdavFiles } from '../functions/lib/webdav-client.js';

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

test('buildBackupFilename uses UTC timestamp with expected format', () => {
  const date = new Date('2026-08-07T15:31:42.000Z');
  assert.match(buildBackupFilename(date), /^iori-nav-backup-20260807-153142-000-[0-9a-f]{32}\.json$/);
  assert.notEqual(buildBackupFilename(date), buildBackupFilename(date), '同一毫秒生成的文件名也不应碰撞');
});

test('buildWebdavUrl strips traversal segments written with backslashes', () => {
  // 入口校验已拒绝反斜杠，这里兜底历史脏数据：URL 里不得出现 %5C 或 ..
  const url = buildWebdavUrl('https://dav.example.com/', 'ok\\..\\..\\etc', 'f.json');
  assert.equal(url, 'https://dav.example.com/ok/etc/f.json');
  assert.ok(!url.includes('%5C'), '反斜杠不应原样编码进 URL');
  assert.ok(!url.includes('..'), '穿越段应被剥离');
});

test('buildWebdavUrl rejects encoded separators that could double-decode into traversal', () => {
  // %2f/%5c 一旦被服务端二次解码就会变成 / 或 \，与 .. 组合可穿越目录；
  // 无法区分合法用途，备份目录里出现这类片段一律按无效地址处理
  for (const dir of ['..%2f..%2fetc', '..%5c..%5cetc', 'a%2Fb', 'a%5Cb']) {
    assert.equal(buildWebdavUrl('https://dav.example.com/', dir, 'f.json'), '');
  }
  assert.equal(buildWebdavUrl('https://dav.example.com/', 'normal/dir', 'f.json'), 'https://dav.example.com/normal/dir/f.json');
});

test('buildWebdavUrl appends paths before query parameters and drops fragments', () => {
  const url = buildWebdavUrl('https://dav.example.com/root/?token=abc#section', '备份 目录', 'f.json');
  assert.equal(url, 'https://dav.example.com/root/%E5%A4%87%E4%BB%BD%20%E7%9B%AE%E5%BD%95/f.json?token=abc');

  const dirUrl = buildWebdavUrl('https://dav.example.com/root/?token=abc#section', '备份 目录', '', true);
  assert.equal(dirUrl, 'https://dav.example.com/root/%E5%A4%87%E4%BB%BD%20%E7%9B%AE%E5%BD%95/?token=abc');
});

test('buildWebdavUrl rejects credentials embedded in legacy base URLs', () => {
  assert.equal(buildWebdavUrl('https://user:secret@dav.example.com/root', 'backup', 'f.json'), '');
});

test('buildWebdavUrl rejects HTTP URLs from legacy settings', () => {
  assert.equal(buildWebdavUrl('http://dav.example.com/root', 'backup', 'f.json'), '');
});

test('parsePropfindEntries skips collections and decodes names', () => {
  const entries = parsePropfindEntries(PROPFIND_XML);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(e => e.name), [
    'iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json',
    'iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json',
    'unrelated-note.txt',
  ]);
  assert.equal(entries[0].size, 2048);
});

test('parsePropfindEntries keeps only direct children of the requested directory', () => {
  // 服务端可以在 multistatus 里塞任意 href。别处的文件若被当成本目录的备份列出，
  // 就会被下载并恢复进库，所以按请求目录的路径前缀过滤
  const hostile = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/nav/</D:href>
    <D:propstat><D:prop><D:getcontentlength>0</D:getcontentlength></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/nav/iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json</D:href>
    <D:propstat><D:prop><D:getcontentlength>2048</D:getcontentlength></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/someone-else/iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json</D:href>
    <D:propstat><D:prop><D:getcontentlength>4096</D:getcontentlength></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>https://attacker.example/nav/iori-nav-backup-20260303-090000-000-20260303090000aaaaaaaaaaaaaaaaaa.json</D:href>
    <D:propstat><D:prop><D:getcontentlength>4096</D:getcontentlength></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/nav/deeper/iori-nav-backup-20260404-100000-000-20260404100000aaaaaaaaaaaaaaaaaa.json</D:href>
    <D:propstat><D:prop><D:getcontentlength>4096</D:getcontentlength></D:prop></D:propstat>
  </D:response>
</D:multistatus>`;

  const entries = parsePropfindEntries(hostile, 'https://dav.example.com/nav/');

  // 目录自身（没标 <collection/>）、别的目录、更深层，全部排除
  assert.deepEqual(entries.map(e => e.name), ['iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json']);
});

test('parsePropfindEntries survives comments and CDATA in the response', () => {
  // 注释里的 </D:response> 会把块提前截断，真实条目连带丢失
  const tricky = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <!-- </D:response> 这段注释不该截断下面的 href -->
    <D:href><![CDATA[/nav/iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json]]></D:href>
    <D:propstat><D:prop><D:getcontentlength>2048</D:getcontentlength></D:prop></D:propstat>
  </D:response>
</D:multistatus>`;

  const entries = parsePropfindEntries(tricky, 'https://dav.example.com/nav/');

  assert.deepEqual(entries.map(e => e.name), ['iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json']);
  assert.equal(entries[0].size, 2048);
});

test('parsePropfindEntries skips malformed percent escapes without losing valid backups', () => {
  const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/nav/unrelated-100%.txt</D:href>
    <D:propstat><D:prop><D:getcontentlength>10</D:getcontentlength></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/nav/iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json</D:href>
    <D:propstat><D:prop><D:getcontentlength>2048</D:getcontentlength></D:prop></D:propstat>
  </D:response>
</D:multistatus>`;

  const entries = parsePropfindEntries(xml, 'https://dav.example.com/nav/');

  assert.deepEqual(entries.map(entry => entry.name), [
    'iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json',
  ]);
});

test('parsePropfindEntries accepts equivalent paths normalized by the WebDAV server', () => {
  const filename = 'iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json';
  const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/~user/${filename}</D:href>
    <D:propstat><D:prop><D:getcontentlength>2048</D:getcontentlength></D:prop></D:propstat>
  </D:response>
</D:multistatus>`;

  const entries = parsePropfindEntries(xml, 'https://dav.example.com/dav/%7Euser/');

  assert.deepEqual(entries.map(entry => entry.name), [filename]);
});

test('parsePropfindEntries decodes XML entities in WebDAV href paths', () => {
  const filename = 'iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json';
  const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/nav&amp;archive&#47;${filename}</D:href>
    <D:propstat><D:prop><D:getcontentlength>2048</D:getcontentlength></D:prop></D:propstat>
  </D:response>
</D:multistatus>`;

  const entries = parsePropfindEntries(xml, 'https://dav.example.com/nav%26archive/');

  assert.deepEqual(entries.map(entry => entry.name), [filename]);
});

test('parsePropfindEntries fails closed when the requested directory path is malformed', () => {
  assert.deepEqual(
    parsePropfindEntries(PROPFIND_XML, 'https://dav.example.com/nav%/'),
    [],
  );
});

test('listWebdavFiles fails loudly when the directory URL is malformed', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('should not reach fetch');
  };
  try {
    const result = await listWebdavFiles({
      baseUrl: 'https://dav.example.com/nav%/',
      dir: '',
      username: 'u',
      password: 'p',
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /无效/);
    assert.equal(fetchCalled, false, '地址无效时不应发出网络请求');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parseBackupFilename extracts ISO time, rejects foreign names', () => {
  assert.equal(
    parseBackupFilename('iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json'),
    '2026-01-01T10:15:00.000Z'
  );
  // 毫秒与随机后缀是必需段：缺段的名字不再被当作备份
  assert.equal(parseBackupFilename('iori-nav-backup-20260101-101500.json'), '');
  // 结构合规但日期非法
  assert.equal(parseBackupFilename(`iori-nav-backup-20261345-996100-000-${'a'.repeat(32)}.json`), '');
  assert.equal(
    parseBackupFilename(`iori-nav-backup-20260101-101500-123-${'a'.repeat(32)}.json`),
    '2026-01-01T10:15:00.123Z'
  );
  assert.equal(parseBackupFilename('unrelated-note.txt'), '');
  assert.equal(parseBackupFilename(''), '');
});

test('selectRecentBackups filters, sorts newest-first and caps the list', () => {
  const picked = selectRecentBackups(parsePropfindEntries(PROPFIND_XML));
  assert.equal(picked.length, 2);
  assert.equal(picked[0].filename, 'iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json');
  assert.equal(picked[1].filename, 'iori-nav-backup-20260101-101500-000-20260101101500aaaaaaaaaaaaaaaaaa.json');

  const many = Array.from({ length: 14 }, (_, i) => ({
    name: `iori-nav-backup-202601${String(i + 1).padStart(2, '0')}-000000-000-${'a'.repeat(32)}.json`,
  }));
  const capped = selectRecentBackups(many);
  assert.equal(capped.length, 10);
  assert.equal(capped[0].filename, `iori-nav-backup-20260114-000000-000-${'a'.repeat(32)}.json`);
});
