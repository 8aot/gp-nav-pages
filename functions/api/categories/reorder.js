import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../../_middleware';

const REORDER_CHUNK_SIZE = 100;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  // 分块提交属于多事务写入，中途失败会留下部分变更。打脏标记统一放在 finally：
  // KV 对同一个 key 限制每秒一次写入，同一请求内写两次可能被静默丢弃，
  // 而 finally 一次就能覆盖成功、抛错和校验早返回三种出口。
  let dbMayHaveChanged = false;

  try {
    const { items } = await request.json();

    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse('排序数据不能为空', 400);
    }

    const statements = [];

    for (const item of items) {
      const id = Number(item.id);
      const sortOrder = Number(item.sort_order);

      if (!Number.isFinite(id) || !Number.isFinite(sortOrder)) {
        return errorResponse('排序数据格式无效', 400);
      }

      statements.push(
        env.NAV_DB.prepare(
          'UPDATE category SET sort_order = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind(sortOrder, id)
      );
    }

    dbMayHaveChanged = true;
    for (let i = 0; i < statements.length; i += REORDER_CHUNK_SIZE) {
      await env.NAV_DB.batch(statements.slice(i, i + REORDER_CHUNK_SIZE));
    }

    return jsonResponse({
      code: 200,
      message: `成功更新 ${items.length} 个分类的排序`
    });
  } catch (e) {
    return errorResponse(`保存分类排序失败: ${e.message}`, 500);
  } finally {
    if (dbMayHaveChanged) {
      await markHomeCacheDirty(env, 'all');
    }
  }
}
