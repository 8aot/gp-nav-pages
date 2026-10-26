import { errorResponse, jsonResponse } from '../../_middleware';

export async function onRequestPost({ request, env }) {
  try {
    const { id, password } = await request.json();
    const [linkRow, categoryRow] = await Promise.all([
      env.NAV_DB.prepare("SELECT value FROM settings WHERE key = 'friend_links'").first(),
      env.NAV_DB.prepare("SELECT value FROM settings WHERE key = 'friend_link_category_passwords'").first()
    ]);
    const links = JSON.parse(linkRow?.value || '[]');
    const categoryPasswords = JSON.parse(categoryRow?.value || '{}');
    const item = links.find(x => String(x.id) === String(id));
    if (!item) return errorResponse('链接不存在', 404);
    const category = String(item.category || '默认');
    const requiredPassword = categoryPasswords[category] || item.password || '';
    if (requiredPassword && String(password || '') !== requiredPassword) return errorResponse('密码错误', 403);
    return jsonResponse({ code: 200, data: { url: item.url } });
  } catch { return errorResponse('验证失败', 400); }
}
