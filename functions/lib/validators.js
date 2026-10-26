// Shared input bounds for D1-backed user content.

export const INPUT_LIMITS = {
  categoryName: 80,
  bookmarkName: 120,
  bookmarkUrl: 2048,
  bookmarkLogo: 2048,
  bookmarkDesc: 1000,
  importCategories: 2000,
  importSites: 10000,
};

// 导入接口与 WebDAV 备份/恢复共用的 UTF-8 体积上限。
// 按实测约 300 字节/条估算，importCategories + importSites 跑满约 4MB，
// 10MB 留足余量的同时避免 request.json() 把 Worker 撑爆（isolate 上限 128MB）。
// 上限依据由 test/api-config-import.test.mjs 的满额体积测试锁定。
export const IMPORT_BODY_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_BODY_MAX_MB = IMPORT_BODY_MAX_BYTES / 1024 / 1024;

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim();
}

function validateTextLength(text, label, maxLength) {
  if (text.length > maxLength) {
    return { ok: false, message: `${label}不能超过 ${maxLength} 个字符` };
  }
  return { ok: true };
}

export function normalizeRequiredText(value, label, maxLength) {
  const text = normalizeText(value);
  if (!text) {
    return { ok: false, message: `${label}不能为空` };
  }

  const lengthCheck = validateTextLength(text, label, maxLength);
  if (!lengthCheck.ok) return lengthCheck;

  return { ok: true, value: text };
}

export function normalizeOptionalText(value, label, maxLength, options = {}) {
  const text = normalizeText(value);
  if (!text) {
    return { ok: true, value: options.nullIfEmpty ? null : '' };
  }

  const lengthCheck = validateTextLength(text, label, maxLength);
  if (!lengthCheck.ok) return lengthCheck;

  return { ok: true, value: text };
}

// 不透明文本（凭据、key、路径）的通用校验：长度 + 控制字符。
// 控制字符会破坏日志、换行拆分、终端回显，四份实现此前各写一份正则，放宽时容易漏改。
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

export function validateOpaqueText(value, maxLength) {
  const text = String(value ?? '');
  if (text.length > maxLength || CONTROL_CHAR_PATTERN.test(text)) {
    return { ok: false };
  }
  return { ok: true, value: text };
}

export function normalizeCategoryName(value) {
  return normalizeRequiredText(value, '分类名称', INPUT_LIMITS.categoryName);
}

export function normalizeBookmarkName(value) {
  return normalizeRequiredText(value, '书签名称', INPUT_LIMITS.bookmarkName);
}

export function normalizeBookmarkUrl(value) {
  return normalizeRequiredText(value, 'URL', INPUT_LIMITS.bookmarkUrl);
}

export function normalizeOptionalBookmarkUrl(value) {
  return normalizeOptionalText(value, 'URL', INPUT_LIMITS.bookmarkUrl);
}

export function normalizeBookmarkLogo(value, options = {}) {
  return normalizeOptionalText(value, 'Logo', INPUT_LIMITS.bookmarkLogo, options);
}

export function normalizeBookmarkDesc(value, options = {}) {
  return normalizeOptionalText(value, '描述', INPUT_LIMITS.bookmarkDesc, options);
}

export function validateImportSizes(categories, sites) {
  if (Array.isArray(categories) && categories.length > INPUT_LIMITS.importCategories) {
    return { ok: false, message: `导入分类数量不能超过 ${INPUT_LIMITS.importCategories} 个` };
  }

  if (Array.isArray(sites) && sites.length > INPUT_LIMITS.importSites) {
    return { ok: false, message: `导入书签数量不能超过 ${INPUT_LIMITS.importSites} 个` };
  }

  return { ok: true };
}
