// functions/api/graph.js
// 关系图谱数据接口：分类树 + 站点归属构成节点与边
import { isAdminAuthenticated, errorResponse, getGraphCacheGeneration } from '../_middleware';

const GRAPH_TOTAL_NODE_LIMIT = 600;
const GRAPH_CATEGORY_LIMIT = 300;
const GRAPH_SITE_LIMIT = 600;
const GRAPH_CACHE_KEY_PREFIX = 'graph_cache_';
const GRAPH_CACHE_TTL = 300;

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  // 将 generation 放进缓存键，避免失效后并发请求把旧快照重新写回当前键。
  const generation = await getGraphCacheGeneration(env);
  const cacheKey = generation ? `${GRAPH_CACHE_KEY_PREFIX}${generation}` : null;
  if (cacheKey) {
    try {
      const cached = await env.NAV_AUTH.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Cache': 'HIT',
          },
        });
      }
    } catch (e) {
      console.warn('Graph cache read failed:', e);
    }
  }

  try {
    const categoryQuery = `SELECT id, catelog, parent_id FROM category ORDER BY sort_order ASC, id ASC LIMIT ${GRAPH_CATEGORY_LIMIT}`;
    const categoryCountQuery = 'SELECT COUNT(*) AS total FROM category';

    const [categoriesResult, categoryCountResult] = await Promise.all([
      env.NAV_DB.prepare(categoryQuery).all(),
      env.NAV_DB.prepare(categoryCountQuery).first(),
    ]);

    const categories = categoriesResult.results || [];
    const totalCategories = Number(categoryCountResult?.total || 0);
    const siteLimit = Math.max(0, GRAPH_TOTAL_NODE_LIMIT - categories.length);

    const categoryIds = new Set(categories.map(c => c.id));
    const nodes = [];
    const edges = [];

    const catById = new Map(categories.map(c => [c.id, c]));
    const levelCache = new Map();
    function getCategoryLevel(cat, visited = new Set()) {
      if (levelCache.has(cat.id)) return levelCache.get(cat.id);
      if (!cat.parent_id || !catById.has(cat.parent_id) || visited.has(cat.id)) {
        levelCache.set(cat.id, 1);
        return 1;
      }
      visited.add(cat.id);
      const lvl = getCategoryLevel(catById.get(cat.parent_id), visited) + 1;
      levelCache.set(cat.id, lvl);
      return lvl;
    }

    for (const cat of categories) {
      nodes.push({
        id: `cat:${cat.id}`,
        title: cat.catelog,
        kind: 'category',
        level: getCategoryLevel(cat),
      });
      if (cat.parent_id && categoryIds.has(cat.parent_id)) {
        edges.push({ source: `cat:${cat.parent_id}`, target: `cat:${cat.id}` });
      }
    }

    let totalSites = 0;
    let sites = [];
    if (categoryIds.size > 0 && siteLimit > 0) {
      const categorySubquery = `SELECT id FROM category ORDER BY sort_order ASC, id ASC LIMIT ${GRAPH_CATEGORY_LIMIT}`;
      const sitesQuery = `SELECT s.id, s.name, s.url, s.logo, s.catelog_id
        FROM sites s
        WHERE s.catelog_id IN (${categorySubquery})
        ORDER BY s.sort_order ASC, s.id ASC
        LIMIT ${GRAPH_SITE_LIMIT}`;
      const siteCountQuery = `SELECT COUNT(*) AS total
        FROM sites s
        WHERE s.catelog_id IN (${categorySubquery})`;
      const [sitesResult, siteCountResult] = await Promise.all([
        env.NAV_DB.prepare(sitesQuery).all(),
        env.NAV_DB.prepare(siteCountQuery).first(),
      ]);
      totalSites = Number(siteCountResult?.total || 0);
      sites = (sitesResult.results || []).slice(0, siteLimit);
    }

    for (const site of sites) {
      nodes.push({
        id: `site:${site.id}`,
        title: site.name || '未命名',
        kind: 'site',
        url: site.url || '',
        logo: site.logo || '',
      });
      edges.push({ source: `cat:${site.catelog_id}`, target: `site:${site.id}` });
    }

    const body = JSON.stringify({
      code: 200,
      data: {
        nodes,
        edges,
        meta: {
          totalCategories,
          categoryTruncated: totalCategories > categories.length,
          categoryLimit: GRAPH_CATEGORY_LIMIT,
          totalSites,
          truncated: totalSites > siteLimit,
          limit: siteLimit,
          nodeLimit: GRAPH_TOTAL_NODE_LIMIT,
        },
      },
    });

    if (cacheKey) {
      context.waitUntil(
        env.NAV_AUTH.put(cacheKey, body, { expirationTtl: GRAPH_CACHE_TTL }).catch(e => {
          console.warn('Graph cache write failed:', e);
        })
      );
    }

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Cache': 'MISS',
      },
    });
  } catch (e) {
    return errorResponse(`Failed to build graph: ${e.message}`, 500);
  }
}
