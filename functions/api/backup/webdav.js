// functions/api/backup/webdav.js
// 手动触发的书签 WebDAV 备份（仅备份分类 + 书签，含私密内容）

import { isAdminAuthenticated, errorResponse, jsonResponse, checkRateLimit } from '../../_middleware';
import { fetchBookmarkExport, validateBookmarkExportForImport } from '../../lib/bookmark-export';
import {
  uploadToWebdav,
  listWebdavFiles,
  downloadWebdavFile,
  deleteWebdavFile,
  getUtf8ByteLength,
} from '../../lib/webdav-client';
import { IMPORT_BODY_MAX_BYTES, IMPORT_BODY_MAX_MB } from '../../lib/validators';

const WEBDAV_KEYS = ['webdav_url', 'webdav_username', 'webdav_password', 'webdav_dir'];

// 备份列表与恢复的最大条数
const BACKUP_LIST_LIMIT = 10;

// 只认本程序生成的文件名，顺带杜绝路径穿越（不含 / 与 ..）
// 毫秒与随机后缀是必需段：防同秒并发覆盖，也让目录里的外来文件不被当成备份
const BACKUP_FILENAME_RE = /^iori-nav-backup-(\d{8})-(\d{6})-(\d{3})-[0-9a-f]{32}\.json$/i;

/**
 * 生成不会因同秒并发而碰撞的 UTC 时间戳文件名：
 * iori-nav-backup-YYYYMMDD-HHmmss-SSS-random.json
 */
export function buildBackupFilename(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');
  const nonce = crypto.randomUUID().replace(/-/g, '');
  return `iori-nav-backup-${stamp}-${milliseconds}-${nonce}.json`;
}

/**
 * 从备份文件名解析 UTC 时间，供前端展示
 * 名称合规不代表日期合法（如 20261345），Date.parse 兜底
 * @returns {string} ISO 字符串，解析不出来时返回空串
 */
export function parseBackupFilename(filename) {
  const m = BACKUP_FILENAME_RE.exec(String(filename ?? ''));
  if (!m) return '';
  const [, d, t, milliseconds] = m;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
    + `T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}.${milliseconds}Z`;
  return Number.isNaN(Date.parse(iso)) ? '' : iso;
}

/**
 * 过滤出备份文件并按时间倒序取前 N 个
 * 文件名时间戳定宽，字典序即时间序，不依赖服务器返回 getlastmodified
 */
export function selectRecentBackups(entries, limit = BACKUP_LIST_LIMIT) {
  return (entries || [])
    .filter(entry => BACKUP_FILENAME_RE.test(entry?.name || ''))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, limit)
    .map(entry => ({
      filename: entry.name,
      size: entry.size || 0,
      backupTime: parseBackupFilename(entry.name),
    }));
}

function validateRestorableBackup(data, byteLength) {
  const importCheck = validateBookmarkExportForImport(data);
  if (!importCheck.ok) return importCheck;

  // 备份写的是 JSON.stringify(data, null, 2)，前端恢复时 POST 的是无缩进的
  // JSON.stringify({...data, override})，一定比这里量到的更小，不需要额外余量
  if (byteLength > IMPORT_BODY_MAX_BYTES) {
    return { ok: false, message: `备份内容超过 ${IMPORT_BODY_MAX_MB}MB 导入限制` };
  }

  return { ok: true };
}

async function loadWebdavConfig(env) {
  const placeholders = WEBDAV_KEYS.map(() => '?').join(',');
  const { results } = await env.NAV_DB
    .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .bind(...WEBDAV_KEYS)
    .all();

  const config = {};
  (results || []).forEach(row => {
    config[row.key] = row.value;
  });
  return config;
}

/**
 * 备份 / 列表 / 恢复三个入口共用的前置：鉴权 + 限流 + 读取并校验配置
 * @returns {Promise<{error?: Response, config?: object, baseUrl?: string, password?: string}>}
 */
async function prepareWebdav(context, rateKey, busyMessage) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return { error: errorResponse('Unauthorized', 401) };
  }

  // 这些接口都会向外部服务器发请求，做一层轻量限流
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const { allowed } = await checkRateLimit(env, `${rateKey}_${ip}`, 10, 60);
  if (!allowed) {
    return { error: errorResponse(busyMessage, 429) };
  }

  const config = await loadWebdavConfig(env);
  const baseUrl = String(config.webdav_url || '').trim();
  const password = String(config.webdav_password || '');

  // 分开报缺哪一项：合成一条「请填地址与密码」会让已填地址的用户去查地址，
  // 前端 requireWebdavConfig 也是拆开判断的，两边保持一致
  if (!baseUrl) {
    return { error: errorResponse('WebDAV 未配置，请先填写服务器地址', 400) };
  }
  if (!password) {
    return { error: errorResponse('WebDAV 未配置，请先填写密码', 400) };
  }

  return { config, baseUrl, password };
}

export async function onRequestPost(context) {
  const { env } = context;

  try {
    const prepared = await prepareWebdav(context, 'webdav_backup', '备份请求过于频繁，请稍后再试');
    if (prepared.error) return prepared.error;
    const { config, baseUrl, password } = prepared;

    const data = await fetchBookmarkExport(env, { includePrivate: true });
    const content = JSON.stringify(data, null, 2);
    const byteLength = getUtf8ByteLength(content);
    const restorableCheck = validateRestorableBackup(data, byteLength);
    if (!restorableCheck.ok) {
      return errorResponse(`无法创建可恢复的备份: ${restorableCheck.message}`, 413);
    }
    const filename = buildBackupFilename();

    const result = await uploadToWebdav({
      baseUrl,
      dir: config.webdav_dir || '',
      filename,
      username: config.webdav_username || '',
      password,
      content,
    });

    if (!result.ok) {
      return errorResponse(`备份失败: ${result.message}`, 502);
    }

    return jsonResponse({
      code: 200,
      message: '备份成功',
      data: {
        filename,
        size: byteLength,
        categoryCount: data.category.length,
        siteCount: data.sites.length,
      },
    });
  } catch (e) {
    return errorResponse(`备份失败: ${e.message}`, 500);
  }
}

/**
 * 列出最近的备份，或下载指定备份的内容
 * GET /api/backup/webdav?limit=10                                  列表
 * GET /api/backup/webdav?filename=iori-nav-backup-20260807-231500.json  下载
 */
export async function onRequestGet(context) {
  const { request } = context;

  try {
    const prepared = await prepareWebdav(context, 'webdav_list', '请求过于频繁，请稍后再试');
    if (prepared.error) return prepared.error;
    const { config, baseUrl, password } = prepared;

    const searchParams = new URL(request.url).searchParams;
    const filename = searchParams.get('filename');

    if (filename !== null) {
      return downloadBackup({ config, baseUrl, password, filename });
    }

    const requestedLimit = Number(searchParams.get('limit'));
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 && requestedLimit <= 50
      ? requestedLimit
      : BACKUP_LIST_LIMIT;

    const result = await listWebdavFiles({
      baseUrl,
      dir: config.webdav_dir || '',
      username: config.webdav_username || '',
      password,
    });

    if (!result.ok) {
      // 体积超限走 413，与下载路径保持同一语义
      if (result.tooLarge) {
        return errorResponse(`获取备份列表失败: ${result.message}`, 413);
      }
      return errorResponse(`获取备份列表失败: ${result.message}`, result.status >= 400 && result.status < 500 ? 400 : 502);
    }

    return jsonResponse({
      code: 200,
      message: 'ok',
      data: {
        backups: selectRecentBackups(result.entries, limit),
      },
    });
  } catch (e) {
    return errorResponse(`获取备份列表失败: ${e.message}`, 500);
  }
}

/**
 * 删除指定备份文件
 * DELETE /api/backup/webdav?filename=iori-nav-backup-....json
 */
export async function onRequestDelete(context) {
  const { request } = context;

  try {
    const prepared = await prepareWebdav(context, 'webdav_delete', '删除请求过于频繁，请稍后再试');
    if (prepared.error) return prepared.error;
    const { config, baseUrl, password } = prepared;

    const filename = new URL(request.url).searchParams.get('filename') || '';
    if (!BACKUP_FILENAME_RE.test(filename)) {
      return errorResponse('无效的备份文件名', 400);
    }

    const result = await deleteWebdavFile({
      baseUrl,
      dir: config.webdav_dir || '',
      filename,
      username: config.webdav_username || '',
      password,
    });

    if (!result.ok) {
      const status = result.status === 404
        ? 404
        : (result.status >= 400 && result.status < 500 ? 400 : 502);
      return errorResponse(`删除备份失败: ${result.message}`, status);
    }

    return jsonResponse({
      code: 200,
      message: '备份已删除',
      data: { filename },
    });
  } catch (e) {
    return errorResponse(`删除备份失败: ${e.message}`, 500);
  }
}

/**
 * 下载指定备份文件并解析为书签数据，交给前端走导入预览
 */
async function downloadBackup({ config, baseUrl, password, filename }) {
  // 只认本程序生成的文件名，顺带杜绝路径穿越
  if (!BACKUP_FILENAME_RE.test(filename)) {
    return errorResponse('无效的备份文件名', 400);
  }

  try {
    const result = await downloadWebdavFile({
      baseUrl,
      dir: config.webdav_dir || '',
      filename,
      username: config.webdav_username || '',
      password,
      // 上限在读取时生效：先看 Content-Length，chunked 响应则边读边计数并提前 cancel
      maxBytes: IMPORT_BODY_MAX_BYTES,
    });

    if (!result.ok) {
      // 体积超限走 413，与备份侧的「无法创建可恢复的备份」保持同一语义
      if (result.tooLarge) {
        return errorResponse(`备份超出恢复限制: ${result.message}`, 413);
      }
      return errorResponse(`下载备份失败: ${result.message}`, result.status >= 400 && result.status < 500 ? 400 : 502);
    }

    let parsed;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      return errorResponse('备份文件内容不是有效的 JSON', 400);
    }

    if (!parsed || !Array.isArray(parsed.category) || !Array.isArray(parsed.sites)) {
      return errorResponse('备份文件格式不正确', 400);
    }

    const restorableCheck = validateRestorableBackup(parsed, result.byteLength);
    if (!restorableCheck.ok) {
      return errorResponse(`备份超出恢复限制: ${restorableCheck.message}`, 413);
    }

    return jsonResponse({
      code: 200,
      message: 'ok',
      data: {
        filename,
        size: result.byteLength,
        category: parsed.category,
        sites: parsed.sites,
      },
    });
  } catch (e) {
    return errorResponse(`下载备份失败: ${e.message}`, 500);
  }
}
