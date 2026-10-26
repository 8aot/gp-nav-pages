import { errorResponse, jsonResponse } from '../../_middleware';

async function hashPassword(password) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// Validate a category password without ever returning the stored hash.
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const id = Number(body.category_id);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!Number.isInteger(id) || id < 1 || !password) return errorResponse('请输入访问密码', 400);
    const category = await env.NAV_DB.prepare('SELECT id, password_hash FROM category WHERE id = ?').bind(id).first();
    if (!category) return errorResponse('分类不存在', 404);
    if (!category.password_hash) return jsonResponse({ code: 200, unlocked: true });
    if (await hashPassword(password) !== category.password_hash) return errorResponse('访问密码错误', 403);
    // 只在密码验证成功后返回该分类及其子分类的书签，受保护内容不会预先注入公开页面。
    const { results: sites } = await env.NAV_DB.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM category WHERE id = ?
        UNION ALL SELECT c.id FROM category c JOIN subtree s ON c.parent_id = s.id
      )
      SELECT id, name, url, logo, desc, catelog_id, catelog_name
      FROM sites WHERE catelog_id IN (SELECT id FROM subtree) AND is_private = 0
      ORDER BY sort_order ASC, create_time DESC
    `).bind(id).all();
    return jsonResponse({ code: 200, unlocked: true, sites: sites || [] });
  } catch (error) {
    return errorResponse('验证密码失败', 500);
  }
}
