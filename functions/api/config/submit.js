// functions/api/config/submit.js
import { isSubmissionEnabled, errorResponse, jsonResponse, checkRateLimit } from '../../_middleware';
import { normalizeUrlForStorage } from '../../lib/utils';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!isSubmissionEnabled(env)) {
    return errorResponse('Public submission disabled', 403);
  }

  // 基于 IP 的速率限制：每 IP 每分钟最多 5 次提交
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const { allowed } = await checkRateLimit(env, `submit_rate_${ip}`, 5, 60);
  if (!allowed) {
    return errorResponse('提交过于频繁，请稍后再试', 429);
  }

  try {
    const config = await request.json();
    const { name, url, logo, desc, catelog_id } = config;

    const sanitizedName = (name || '').trim();
    const rawUrl = (url || '').trim();
    const sanitizedUrl = normalizeUrlForStorage(rawUrl);
    const sanitizedLogo = (logo || '').trim() || null;
    const sanitizedDesc = (desc || '').trim() || null;

    if (!sanitizedName || !rawUrl || !catelog_id) {
      return errorResponse('Name, URL and Category are required', 400);
    }
    if (!sanitizedUrl) {
      return errorResponse('URL must be a valid http or https URL', 400);
    }

    const categoryResult = await env.NAV_DB.prepare('SELECT catelog, is_private FROM category WHERE id = ?').bind(catelog_id).first();
    if (!categoryResult || categoryResult.is_private === 1) {
      return errorResponse('Category not found', 400);
    }
    const catelogName = categoryResult.catelog;

    await env.NAV_DB.prepare(`
      INSERT INTO pending_sites (name, url, logo, desc, catelog_id, catelog_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(sanitizedName, sanitizedUrl, sanitizedLogo, sanitizedDesc, catelog_id, catelogName).run();

    return jsonResponse({
      code: 201,
      message: 'Config submitted successfully, waiting for admin approve',
    }, 201);
  } catch (e) {
    return errorResponse(`Failed to submit config: ${e.message}`, 500);
  }
}
