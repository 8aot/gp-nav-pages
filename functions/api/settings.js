
import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../_middleware';
import { getSettingsKeys, normalizeSettingValueForStorage } from '../lib/settings-parser';
import { sanitizeUrl } from '../lib/utils';

const LAYOUT_SETTING_KEYS = new Set(getSettingsKeys());
const AI_SETTING_KEYS = new Set(['provider', 'apiKey', 'baseUrl', 'model']);
const IGNORED_SETTING_KEYS = new Set(['has_api_key', 'debug_api_key_info']);
const ALLOWED_PROVIDERS = new Set(['workers-ai', 'gemini', 'openai']);

function normalizeAiSettingValue(key, value) {
  const text = String(value ?? '').trim();

  if (key === 'provider') {
    return ALLOWED_PROVIDERS.has(text)
      ? { ok: true, value: text }
      : { ok: false, message: 'Invalid provider' };
  }

  if (key === 'baseUrl') {
    if (!text) return { ok: true, value: '' };
    const safeUrl = sanitizeUrl(text);
    return safeUrl
      ? { ok: true, value: safeUrl.replace(/\/+$/, '') }
      : { ok: false, message: 'Invalid baseUrl' };
  }

  if (key === 'model') {
    if (text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
      return { ok: false, message: 'Invalid model' };
    }
    return { ok: true, value: text };
  }

  if (key === 'apiKey') {
    if (text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text)) {
      return { ok: false, message: 'Invalid apiKey' };
    }
    return { ok: true, value: text };
  }

  return { ok: false, message: `Unknown setting key: ${key}` };
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    // Try to get all settings
    const { results } = await env.NAV_DB.prepare('SELECT key, value FROM settings').all();

    const settings = {};
    if (results) {
      results.forEach(row => {
        // 忽略后端计算字段或调试字段，防止数据库脏数据覆盖
        if (IGNORED_SETTING_KEYS.has(row.key)) {
          return;
        }

        if (!LAYOUT_SETTING_KEYS.has(row.key) && !AI_SETTING_KEYS.has(row.key)) {
          return;
        }

        // 敏感字段不返回给前端
        if (row.key === 'apiKey') {
          if (row.value && row.value.length > 0) {
            settings['has_api_key'] = true;
          } else {
            settings['has_api_key'] = false;
          }
        } else {
          settings[row.key] = row.value;
        }
      });
    }


    return jsonResponse({
      code: 200,
      data: settings
    });
  } catch (e) {
    // If table doesn't exist, return empty settings or try to create it?
    // For GET, just returning empty is fine if it doesn't exist, but we might want to initialize it.
    if (e.message && (e.message.includes('no such table') || e.message.includes('settings'))) {
      return jsonResponse({
        code: 200,
        data: {} // No settings yet
      });
    }
    return errorResponse(`Failed to fetch settings: ${e.message}`, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  try {
    const body = await request.json();
    const settings = body; // Expecting object { key: value, key2: value2 }

    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return errorResponse('Invalid settings data', 400);
    }

    // Ensure table exists
    try {
      await env.NAV_DB.prepare(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `).run();
    } catch (e) {
      console.error('Failed to ensure settings table:', e);
      // Continue, maybe it exists or error will happen on upsert
    }

    const stmt = env.NAV_DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

    const batch = [];
    for (const [key, value] of Object.entries(settings)) {
      // 不要保存临时字段
      if (IGNORED_SETTING_KEYS.has(key)) continue;

      let normalized;
      if (LAYOUT_SETTING_KEYS.has(key)) {
        normalized = normalizeSettingValueForStorage(key, value);
      } else if (AI_SETTING_KEYS.has(key)) {
        normalized = normalizeAiSettingValue(key, value);
      } else {
        return errorResponse(`Invalid setting key: ${key}`, 400);
      }

      if (!normalized.ok) {
        return errorResponse(normalized.message, 400);
      }

      batch.push(stmt.bind(key, normalized.value));
    }

    if (batch.length > 0) {
      await env.NAV_DB.batch(batch);
    }

    // 清除 settings 缓存和页面缓存，使新设置立即生效
    try {
      await Promise.all([
        env.NAV_AUTH.delete('settings_cache'),
        markHomeCacheDirty(env, 'all'),
      ]);
    } catch (e) {
      console.warn('Failed to clear caches:', e);
    }

    return jsonResponse({
      code: 200,
      message: 'Settings saved'
    });
  } catch (e) {
    return errorResponse(`Failed to save settings: ${e.message}`, 500);
  }
}
