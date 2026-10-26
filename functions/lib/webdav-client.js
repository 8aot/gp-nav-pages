// functions/lib/webdav-client.js
// 极简 WebDAV 上传客户端：Basic 认证 + PUT，目录缺失时逐级 MKCOL 后重试
// 注意：任何返回值与日志都不得包含密码

import { sanitizeUrl } from './utils';

// 编码后的分隔符（%2F=%2f、%5C=%5c）：encodeURIComponent 会把它变成 %252f，
// 但极少数服务端会把 %25xx 二次解码成分隔符，再配合 .. 就能穿越目录。
// 备份目录里不存在合法的 %2f/%5c 用途，按无效地址处理。
const ENCODED_SEPARATOR_PATTERN = /%(?:2f|5c)/i;

/**
 * 拆分目录字符串为路径片段（忽略空段与 . / ..）
 * 反斜杠一并按分隔符切开：它不是 WebDAV 路径分隔符，但 Windows 系服务端
 * 可能据此解析目录，切开后 .. 段才能被下面的过滤规则拦住
 */
export function splitDirSegments(dir) {
    return String(dir ?? '')
        .split(/[/\\]/)
        .map(segment => segment.trim())
        .filter(segment => segment && segment !== '.' && segment !== '..');
}

/**
 * 拼接 WebDAV 目标地址，各路径段单独编码以兼容中文/空格
 * @param {boolean} trailingSlash - 是否让目录路径以斜杠结尾（斜杠会放在 query 之前）
 * @returns {string} 完整 URL，baseUrl 非法时返回空字符串
 */
export function buildWebdavUrl(baseUrl, dir, filename, trailingSlash = false) {
    const safeBase = sanitizeUrl(baseUrl);
    if (!safeBase) return '';

    if (ENCODED_SEPARATOR_PATTERN.test(String(dir ?? ''))) return '';

    const segments = splitDirSegments(dir);
    if (filename) segments.push(filename);

    const encodedPath = segments.map(segment => encodeURIComponent(segment)).join('/');
    const parsed = new URL(safeBase);
    // 防御历史脏数据：凭据和私密备份不得通过 HTTP 传输；Fetch 也不接受带 userinfo 的 URL。
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    const basePath = parsed.pathname.replace(/\/+$/, '');
    let pathname = encodedPath ? `${basePath}/${encodedPath}` : (basePath || '/');
    if (trailingSlash && !pathname.endsWith('/')) {
        pathname += '/';
    }

    parsed.pathname = pathname;
    // 片段不会发送到 WebDAV 服务端，也不应成为目标资源标识的一部分
    parsed.hash = '';
    return parsed.href;
}

/**
 * UTF-8 字节长度（String.length 是 UTF-16 码元数，中文会少算 2/3）
 */
export function getUtf8ByteLength(text) {
    return new TextEncoder().encode(String(text ?? '')).byteLength;
}

function buildAuthHeader(username, password) {
    // btoa 只接受 Latin-1，中文账号/密码会抛 InvalidCharacterError，先转成 UTF-8 字节
    const bytes = new TextEncoder().encode(`${username ?? ''}:${password ?? ''}`);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return `Basic ${btoa(binary)}`;
}

/**
 * 所有 WebDAV 请求的唯一出口：禁止自动跟随重定向。
 * 每个请求都带 Basic 凭据，跟随 30x 就可能把账号密码原样发给 Location 指向的主机
 * （被接管的自建 DAV、共享主机的邻居 vhost 都够用）。规范要求跨源重定向剥离
 * Authorization，但这只是运行时的兜底，不该拿凭据去赌它一定实现。
 * 3xx 一律当错误，让调用方给出「地址需要更新」而不是静默换目标。
 */
async function webdavFetch(url, init) {
    return fetch(url, { ...init, redirect: 'manual' });
}

/**
 * 重定向状态：目标资源已不在配置的地址上
 */
function isRedirectStatus(status) {
    return status >= 300 && status < 400;
}

const REDIRECT_MESSAGE = 'WebDAV 服务器要求重定向，请把设置里的服务器地址改为最终地址';

// PROPFIND 返回的是目录元数据 XML，不是备份内容。几千个条目也远不到 5MB，
// 这里只是防住「目录异常庞大或服务端乱吐」把 isolate 撑爆
const LIST_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 目录不存在时服务器通常返回 409（部分实现返回 404）
 */
function isMissingParentStatus(status) {
    return status === 404 || status === 409;
}

/**
 * 逐级创建目录，405 视为目录已存在
 * 失败时回传出错的层级与状态码：只回 false 会把「b 段没权限」说成 PUT 的 409，
 * 用户对着错误的那一层排查
 * @returns {Promise<{ok: boolean, status: number, segment: string}>}
 */
async function ensureWebdavDir(baseUrl, dir, authHeader) {
    const segments = splitDirSegments(dir);
    if (segments.length === 0) return { ok: true, status: 201, segment: '' };

    for (let i = 0; i < segments.length; i++) {
        const path = segments.slice(0, i + 1).join('/');
        const dirUrl = buildWebdavUrl(baseUrl, path, '', true);
        if (!dirUrl) return { ok: false, status: 0, segment: path };

        const res = await webdavFetch(dirUrl, {
            method: 'MKCOL',
            headers: { Authorization: authHeader },
        });

        // 201 新建成功；405 已存在
        if (res.status === 201 || res.status === 405) continue;

        return { ok: false, status: res.status, segment: path };
    }

    return { ok: true, status: 201, segment: '' };
}

/**
 * 从 PROPFIND 的 multistatus XML 中提取文件条目
 * Workers 运行时没有 DOMParser，这里用正则逐个 response 块解析
 * @param {string} dirUrl - 请求目录的完整地址，给了就只保留它的直接子项
 * @returns {Array<{name: string, size: number, lastModified: string}>}
 */
export function parsePropfindEntries(xml, dirUrl = '') {
    // 先剥掉注释：注释里出现 </response> 会把块提前截断，真实条目连带丢失
    const text = String(xml ?? '').replace(/<!--[\s\S]*?-->/g, '');
    const entries = [];

    // href 可以是相对形式，用 dirUrl 当 base 解析；同时拿它的 origin 卡主机
    let base = null;
    let baseDir = '';
    if (dirUrl) {
        try {
            base = new URL(dirUrl);
            // 服务端可能把 %7E 规范化为 ~，解码后比较才能识别为同一目录。
            baseDir = `${decodeURIComponent(base.pathname).replace(/\/+$/, '')}/`;
        } catch {
            // 给了目录却无法安全解析时必须失败关闭，不能退回到「接受任意目录」。
            return entries;
        }
    }

    // 命名空间前缀不固定（d: / D: / lp1: 等），统一用 (?:\w+:)? 兼容
    const responseRe = /<(?:\w+:)?response[\s>][\s\S]*?<\/(?:\w+:)?response>/gi;
    const decodeXmlText = value => String(value ?? '').replace(
        /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos));/gi,
        (entity, decimal, hexadecimal, named) => {
            if (decimal || hexadecimal) {
                const codePoint = Number.parseInt(decimal || hexadecimal, decimal ? 10 : 16);
                try {
                    return String.fromCodePoint(codePoint);
                } catch {
                    // 非法 Unicode 码点保留原文，后续 URL 校验会失败关闭。
                    return entity;
                }
            }
            return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[named.toLowerCase()];
        }
    );
    const pick = (block, tag) => {
        const m = block.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i'));
        if (!m) return '';
        // CDATA 包裹时取其内容，否则 ]]> 会跟进值里
        const cdata = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
        const value = (cdata ? cdata[1] : decodeXmlText(m[1])).trim();
        return value;
    };

    for (const [block] of text.matchAll(responseRe)) {
        // 目录条目带 <collection/>，跳过
        if (/<(?:\w+:)?collection\s*\/?>/i.test(block)) continue;

        const href = pick(block, 'href');
        if (!href) continue;

        let name;
        if (base) {
            // 服务端可以在 multistatus 里塞任意 href。只认请求目录的直接子项，
            // 否则别处的文件会被当成本目录的备份列出，进而被下载、恢复进库
            let parsed;
            let path;
            try {
                parsed = new URL(href, base);
                path = decodeURIComponent(parsed.pathname);
            } catch {
                // 一个异常 href 不应阻断同一目录里其他合法备份的展示。
                continue;
            }
            // 只比路径不够：攻击者主机上同样可以有 /nav/ 这个路径
            if (parsed.origin !== base.origin) continue;

            if (!path.startsWith(baseDir)) continue;

            const rest = path.slice(baseDir.length).replace(/\/+$/, '');
            // 空 = 目录自身（服务端没标 <collection/> 时的兜底）；带 / = 更深层
            if (!rest || rest.includes('/')) continue;
            name = rest;
        } else {
            const rawName = href.replace(/\/+$/, '').split('/').pop() || '';
            try {
                name = decodeURIComponent(rawName);
            } catch {
                name = rawName;
            }
        }
        if (!name) continue;

        entries.push({
            name,
            size: Number(pick(block, 'getcontentlength')) || 0,
            lastModified: pick(block, 'getlastmodified'),
        });
    }

    return entries;
}

/**
 * 列出目录下的文件（PROPFIND Depth: 1）
 * @param {object} params - { baseUrl, dir, username, password }
 * @returns {Promise<{ok: boolean, status: number, message: string, entries: Array}>}
 */
export async function listWebdavFiles(params) {
    const { baseUrl, dir = '', username, password } = params;

    const dirUrl = buildWebdavUrl(baseUrl, dir, '', true);
    if (!dirUrl) {
        return { ok: false, status: 0, message: 'WebDAV 地址无效（仅支持 HTTPS）', entries: [] };
    }

    // parsePropfindEntries 内部会用 decodeURIComponent 处理目录路径，若 baseUrl 含非法
    // percent 编码（如 % 后不是两位十六进制），decodeURIComponent 会抛 URIError，函数
    // 只能返回空列表。提前校验旧配置里的脏地址，避免把「目录地址无效」误报成「暂无备份」。
    try {
        decodeURIComponent(new URL(dirUrl).pathname);
    } catch {
        return { ok: false, status: 0, message: '备份目录地址无效，请检查 WebDAV 设置', entries: [] };
    }

    // 只取需要的属性，减少响应体
    const body = '<?xml version="1.0" encoding="utf-8"?>'
        + '<d:propfind xmlns:d="DAV:"><d:prop>'
        + '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>'
        + '</d:prop></d:propfind>';

    let res;
    try {
        res = await webdavFetch(dirUrl, {
            method: 'PROPFIND',
            headers: {
                Authorization: buildAuthHeader(username, password),
                Depth: '1',
                'Content-Type': 'application/xml; charset=utf-8',
            },
            body,
        });
    } catch (e) {
        return { ok: false, status: 0, message: `无法连接 WebDAV 服务器: ${e.message}`, entries: [] };
    }

    if (isRedirectStatus(res.status)) {
        return { ok: false, status: res.status, message: REDIRECT_MESSAGE, entries: [] };
    }
    if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, message: 'WebDAV 认证失败，请检查账号与密码', entries: [] };
    }
    if (res.status === 404) {
        return { ok: false, status: 404, message: '备份目录不存在，请先执行一次备份', entries: [] };
    }
    if (!res.ok) {
        return { ok: false, status: res.status, message: `WebDAV 返回 ${res.status}`, entries: [] };
    }

    const read = await readTextWithLimit(res, LIST_RESPONSE_MAX_BYTES);
    if (!read.ok) {
        return {
            ok: false,
            tooLarge: true,
            status: res.status,
            message: `备份目录列表超过 ${Math.round(LIST_RESPONSE_MAX_BYTES / 1024 / 1024)}MB，请清理目录后重试`,
            entries: [],
        };
    }

    // 只认这个目录的直接子项，避免服务端在 multistatus 里塞别处的文件
    return { ok: true, status: res.status, message: '', entries: parsePropfindEntries(read.text, dirUrl) };
}

/**
 * 按字节上限读取响应体
 * 服务端未给 Content-Length 时（chunked）仍需守住上限，所以边读边计数，
 * 超限立刻 cancel —— 不能先 res.text() 再校验，那时内存已经吃完了
 * @returns {Promise<{ok: boolean, tooLarge?: boolean, text?: string}>}
 */
async function readTextWithLimit(res, maxBytes) {
    const declared = Number(res.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        return { ok: false, tooLarge: true };
    }

    if (!res.body) {
        return { ok: true, text: await res.text() };
    }

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            try {
                await reader.cancel();
            } catch {
                // cancel 失败不能改变超限结论：调用方应收到 413，而不是 500
            }
            return { ok: false, tooLarge: true };
        }
        chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return { ok: true, text: new TextDecoder().decode(merged) };
}

/**
 * 下载单个文件内容
 * @param {object} params - { baseUrl, dir, filename, username, password, maxBytes }
 * @returns {Promise<{ok: boolean, status: number, message: string, content: string, byteLength: number}>}
 */
export async function downloadWebdavFile(params) {
    const { baseUrl, dir = '', filename, username, password, maxBytes } = params;

    const targetUrl = buildWebdavUrl(baseUrl, dir, filename);
    if (!targetUrl || !filename) {
        return { ok: false, status: 0, message: 'WebDAV 地址无效（仅支持 HTTPS）', content: '', byteLength: 0 };
    }

    let res;
    try {
        res = await webdavFetch(targetUrl, {
            method: 'GET',
            headers: { Authorization: buildAuthHeader(username, password) },
        });
    } catch (e) {
        return { ok: false, status: 0, message: `无法连接 WebDAV 服务器: ${e.message}`, content: '', byteLength: 0 };
    }

    if (isRedirectStatus(res.status)) {
        return { ok: false, status: res.status, message: REDIRECT_MESSAGE, content: '', byteLength: 0 };
    }
    if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, message: 'WebDAV 认证失败，请检查账号与密码', content: '', byteLength: 0 };
    }
    if (res.status === 404) {
        return { ok: false, status: 404, message: '备份文件不存在', content: '', byteLength: 0 };
    }
    if (!res.ok) {
        return { ok: false, status: res.status, message: `WebDAV 返回 ${res.status}`, content: '', byteLength: 0 };
    }

    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
        const text = await res.text();
        return { ok: true, status: res.status, message: '', content: text, byteLength: getUtf8ByteLength(text) };
    }

    const read = await readTextWithLimit(res, maxBytes);
    if (!read.ok) {
        return {
            ok: false,
            tooLarge: true,
            status: res.status,
            message: `备份文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 恢复上限`,
            content: '',
            byteLength: 0,
        };
    }

    return { ok: true, status: res.status, message: '', content: read.text, byteLength: getUtf8ByteLength(read.text) };
}

/**
 * 删除单个 WebDAV 文件
 * @param {object} params - { baseUrl, dir, filename, username, password }
 * @returns {Promise<{ok: boolean, status: number, message: string}>}
 */
export async function deleteWebdavFile(params) {
    const { baseUrl, dir = '', filename, username, password } = params;

    const targetUrl = buildWebdavUrl(baseUrl, dir, filename);
    if (!targetUrl || !filename) {
        return { ok: false, status: 0, message: 'WebDAV 地址无效（仅支持 HTTPS）' };
    }

    let res;
    try {
        res = await webdavFetch(targetUrl, {
            method: 'DELETE',
            headers: { Authorization: buildAuthHeader(username, password) },
        });
    } catch (e) {
        return { ok: false, status: 0, message: `无法连接 WebDAV 服务器: ${e.message}` };
    }

    if (isRedirectStatus(res.status)) {
        return { ok: false, status: res.status, message: REDIRECT_MESSAGE };
    }
    if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, message: 'WebDAV 认证失败，请检查账号与密码' };
    }
    if (res.status === 404) {
        return { ok: false, status: 404, message: '备份文件不存在或已被删除' };
    }
    if (!res.ok) {
        return { ok: false, status: res.status, message: `WebDAV 返回 ${res.status}` };
    }

    return { ok: true, status: res.status, message: '删除成功' };
}

/**
 * 上传文件到 WebDAV
 * @param {object} params - { baseUrl, dir, filename, username, password, content }
 * @returns {Promise<{ok: boolean, status: number, message: string, url: string}>}
 */
export async function uploadToWebdav(params) {
    const { baseUrl, dir = '', filename, username, password, content } = params;

    const targetUrl = buildWebdavUrl(baseUrl, dir, filename);
    if (!targetUrl) {
        return { ok: false, status: 0, message: 'WebDAV 地址无效（仅支持 HTTPS）', url: '' };
    }

    const authHeader = buildAuthHeader(username, password);
    const putInit = {
        method: 'PUT',
        headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: content,
    };

    let res;
    try {
        res = await webdavFetch(targetUrl, putInit);
    } catch (e) {
        return { ok: false, status: 0, message: `无法连接 WebDAV 服务器: ${e.message}`, url: targetUrl };
    }

    if (isRedirectStatus(res.status)) {
        return { ok: false, status: res.status, message: REDIRECT_MESSAGE, url: targetUrl };
    }

    // 目录缺失：尝试创建后重试一次
    if (isMissingParentStatus(res.status) && splitDirSegments(dir).length > 0) {
        let dirResult;
        try {
            dirResult = await ensureWebdavDir(baseUrl, dir, authHeader);
        } catch (e) {
            return { ok: false, status: res.status, message: `创建备份目录失败: ${e.message}`, url: targetUrl };
        }
        // 目录没建成就别重试 PUT：那只会拿同一个 409 盖掉真正的原因
        if (!dirResult.ok) {
            const detail = dirResult.status ? `WebDAV 返回 ${dirResult.status}` : '地址无效';
            return {
                ok: false,
                status: dirResult.status || res.status,
                message: `创建备份目录「${dirResult.segment}」失败: ${detail}`,
                url: targetUrl,
            };
        }
        res = await webdavFetch(targetUrl, putInit);
        if (isRedirectStatus(res.status)) {
            return { ok: false, status: res.status, message: REDIRECT_MESSAGE, url: targetUrl };
        }
    }

    if (res.ok) {
        return { ok: true, status: res.status, message: '上传成功', url: targetUrl };
    }

    if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, message: 'WebDAV 认证失败，请检查账号与密码', url: targetUrl };
    }

    return { ok: false, status: res.status, message: `WebDAV 返回 ${res.status}`, url: targetUrl };
}
