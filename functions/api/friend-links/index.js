import { isAdminAuthenticated, errorResponse, jsonResponse } from '../../_middleware';

async function getSetting(env, key, fallback) {
  const row = await env.NAV_DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  try { return JSON.parse(row?.value ?? JSON.stringify(fallback)); } catch { return fallback; }
}
async function putSetting(env, key, value) {
  await env.NAV_DB.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind(key, JSON.stringify(value)).run();
}
export async function onRequestGet({ request, env }) {
  try {
    const [storedLinks, categoryPasswords, admin] = await Promise.all([
      getSetting(env, 'friend_links', []),
      getSetting(env, 'friend_link_category_passwords', {}),
      isAdminAuthenticated(request, env)
    ]);
    const links = Array.isArray(storedLinks) ? storedLinks : [];
    const data = links.map(item => {
      const category = String(item.category || '默认');
      const { password, ...safe } = item;
      const hasPassword = !!(categoryPasswords[category] || password);
      return admin ? { ...safe, password: password || '', hasPassword } : { ...safe, hasPassword };
    });
    return jsonResponse({ code: 200, data, categoryPasswords: admin ? categoryPasswords : undefined });
  } catch (e) { return errorResponse(`Failed to load friend links: ${e.message}`, 500); }
}
export async function onRequestPost({ request, env }) {
  if (!(await isAdminAuthenticated(request, env))) return errorResponse('Unauthorized', 401);
  try {
    const body = await request.json();
    if (!Array.isArray(body.links)) return errorResponse('links must be an array', 400);
    const links = body.links.map((x, i) => {
      const title = String(x.title || '').trim().slice(0, 80);
      const url = String(x.url || '').trim();
      const category = String(x.category || '默认').trim().slice(0, 80) || '默认';
      if (!title || !/^https?:\/\//i.test(url)) throw new Error(`第 ${i + 1} 项名称或网址无效`);
      return { id: String(x.id || `${Date.now()}-${i}`), title, url, category, password: String(x.password || '').slice(0, 200) };
    });
    const categoryPasswords = {};
    if (body.categoryPasswords && typeof body.categoryPasswords === 'object' && !Array.isArray(body.categoryPasswords)) {
      for (const [name, password] of Object.entries(body.categoryPasswords)) {
        const category = String(name).trim().slice(0, 80);
        const value = String(password || '').slice(0, 200);
        if (category && value) categoryPasswords[category] = value;
      }
    }
    await Promise.all([
      putSetting(env, 'friend_links', links),
      putSetting(env, 'friend_link_category_passwords', categoryPasswords)
    ]);
    return jsonResponse({ code: 200, message: '保存成功' });
  } catch (e) { return errorResponse(e.message || '保存失败', 400); }
}
