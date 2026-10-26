// functions/lib/bookmark-export.js
// 书签导出数据查询：供手动导出与 WebDAV 备份共用

import { normalizeUrlForStorage } from './utils';
import {
    normalizeBookmarkDesc,
    normalizeBookmarkLogo,
    normalizeBookmarkName,
    normalizeBookmarkUrl,
    normalizeCategoryName,
    validateImportSizes,
} from './validators';

function idKey(value) {
    return String(value ?? '');
}

function parentIdKey(value) {
    const key = idKey(value);
    return key === '' ? '0' : key;
}

function bookmarkNameForMessage(site) {
    const value = site?.name;
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function bookmarkErrorLabel(site, index) {
    const name = bookmarkNameForMessage(site);
    return `第 ${index + 1} 个书签${name ? `「${name}」` : '（名称为空）'}`;
}

/**
 * 按导入器的规则检查导出数据能否无损恢复。
 * 备份是灾难恢复的最后一道防线，不能在上传时说成功，到恢复时才跳过旧数据。
 */
export function validateBookmarkExportForImport(data) {
    if (!data || !Array.isArray(data.category) || !Array.isArray(data.sites)) {
        return { ok: false, message: '备份数据格式不正确' };
    }

    const sizeCheck = validateImportSizes(data.category, data.sites);
    if (!sizeCheck.ok) return sizeCheck;

    const categoryIds = new Set();
    const normalizedCategoryNames = new Map();
    for (const category of data.category) {
        const key = idKey(category?.id);
        if (!key || key === '0' || categoryIds.has(key)) {
            return { ok: false, message: `分类 ID 无效或重复: ${key || '(空)'}` };
        }

        const name = normalizeCategoryName(category?.catelog);
        if (!name.ok) {
            return { ok: false, message: `分类 ${key}: ${name.message}` };
        }

        categoryIds.add(key);
        normalizedCategoryNames.set(key, name.value);
    }

    // 导入器会把找不到的父级或循环层级降级到根目录，这对备份恢复属于数据丢失。
    const parentById = new Map();
    const siblingNames = new Set();
    for (const category of data.category) {
        const key = idKey(category.id);
        const parentKey = parentIdKey(category.parent_id);
        if (parentKey !== '0' && !categoryIds.has(parentKey)) {
            return { ok: false, message: `分类 ${key} 引用了不存在的父分类 ${parentKey}` };
        }
        parentById.set(key, parentKey);

        const siblingKey = `${parentKey}\u0000${normalizedCategoryNames.get(key)}`;
        if (siblingNames.has(siblingKey)) {
            return { ok: false, message: `同一父分类下存在重名分类: ${normalizedCategoryNames.get(key)}` };
        }
        siblingNames.add(siblingKey);
    }

    for (const categoryId of categoryIds) {
        const seen = new Set();
        let cursor = categoryId;
        while (cursor !== '0') {
            if (seen.has(cursor)) {
                return { ok: false, message: `分类 ${categoryId} 存在循环父级关系` };
            }
            seen.add(cursor);
            cursor = parentById.get(cursor) || '0';
        }
    }

    // dedupKey -> { index, name }，重复时能指出与哪条书签冲突
    const normalizedUrls = new Map();
    for (let index = 0; index < data.sites.length; index++) {
        const site = data.sites[index] || {};
        const label = bookmarkErrorLabel(site, index);
        const name = normalizeBookmarkName(site.name);
        const url = normalizeBookmarkUrl(site.url);
        const logo = normalizeBookmarkLogo(site.logo);
        const desc = normalizeBookmarkDesc(site.desc, { nullIfEmpty: true });

        for (const result of [name, url, logo, desc]) {
            if (!result.ok) return { ok: false, message: `${label}: ${result.message}` };
        }

        const normalizedUrl = normalizeUrlForStorage(url.value);
        if (!normalizedUrl) {
            return { ok: false, message: `${label}: URL 必须使用 http 或 https` };
        }

        const siteCategoryId = idKey(site.catelog_id);
        if (siteCategoryId !== '0' && !categoryIds.has(siteCategoryId)) {
            return { ok: false, message: `${label} 引用了不存在的分类 ${siteCategoryId || '(空)'}` };
        }

        // 与导入器的去重规则保持一致，否则恢复时会静默少一条。
        const dedupKey = normalizedUrl.endsWith('/') ? normalizedUrl.slice(0, -1) : normalizedUrl;
        const existing = normalizedUrls.get(dedupKey);
        if (existing) {
            return { ok: false, message: `${label} 的 URL 与第 ${existing.index + 1} 个书签「${existing.name}」重复` };
        }
        normalizedUrls.set(dedupKey, { index, name: name.value });
    }

    return { ok: true };
}

/**
 * 查询可导出的分类与书签
 * @param {object} env - Cloudflare env（需要 NAV_DB 绑定）
 * @param {object} options - { includePrivate: boolean }
 * @returns {Promise<{category: Array, sites: Array}>}
 */
export async function fetchBookmarkExport(env, options = {}) {
    const includePrivate = options.includePrivate === true;

    let categoryQuery = 'SELECT id, catelog, sort_order, parent_id, is_private FROM category';
    let sitesQuery = 'SELECT id, name, url, logo, desc, catelog_id, sort_order, is_private FROM sites';

    if (!includePrivate) {
        // 分类私密时导入/写入逻辑会把站点一并置为私密，因此这里按 is_private 过滤即可
        categoryQuery += ' WHERE is_private = 0';
        sitesQuery += ' WHERE is_private = 0';
    }

    categoryQuery += ' ORDER BY sort_order ASC';
    sitesQuery += ' ORDER BY sort_order ASC, create_time DESC';

    const [{ results: categories }, { results: sites }] = await Promise.all([
        env.NAV_DB.prepare(categoryQuery).all(),
        env.NAV_DB.prepare(sitesQuery).all(),
    ]);

    return {
        category: categories || [],
        sites: sites || [],
    };
}
