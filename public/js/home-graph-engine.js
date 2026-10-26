// public/js/home-graph-engine.js
// Canvas 力导向图引擎（无框架依赖）：负责节点布局物理模拟与绘制。
// 布局思路参考 inkstone GraphPanel：斥力 + 弹簧力 + 向心力，迭代冻结。
(function () {
  const Home = window.IoriHome = window.IoriHome || {};

  const PHYSICS_FRAME_LIMIT = 360;
  const REPULSION = 900;
  const LINK_DISTANCE = 76;
  const SITE_ICON_SIZE = 18;

  function canUseIcon(url) {
    if (!url) return false;
    // 只加载 http(s) 与站内相对路径图标，其余协议一律回退为圆形节点
    if (url.startsWith('/')) return true;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  function attachIcon(node, onReady) {
    if (node.kind !== 'site' || !canUseIcon(node.logo)) return;
    const img = new Image();
    let retriedOpaque = false;
    img.onload = function () {
      node.icon = img;
      onReady();
    };
    img.onerror = function () {
      // CORS 模式被目标站点拒绝时，回退为普通（非跨域）加载：
      // canvas 只负责展示不读取像素，污染状态不影响绘制
      if (!retriedOpaque) {
        retriedOpaque = true;
        img.removeAttribute('crossorigin');
        img.src = node.logo;
        return;
      }
      node.icon = null;
    };
    // 优先 CORS 加载，避免画布被污染；失败时 onerror 里降级重试
    img.crossOrigin = 'anonymous';
    img.src = node.logo;
  }

  function createGraphEngine(canvas, options) {
    const opts = options || {};
    const state = {
      rawNodes: [],
      rawEdges: [],
      nodes: [],
      edges: [],
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      dragging: null,
      hoverNode: null,
      frame: 0,
      raf: 0,
      destroyed: false,
    };

    function collectSubtreeCategoryIds(categoryId, edges) {
      // 沿「分类 -> 子分类」边收集整棵子树，图谱过滤时一并保留
      const childrenMap = new Map();
      for (const e of edges) {
        if (!e.source.startsWith('cat:') || !e.target.startsWith('cat:')) continue;
        if (!childrenMap.has(e.source)) childrenMap.set(e.source, []);
        childrenMap.get(e.source).push(e.target);
      }
      const result = new Set([categoryId]);
      const queue = [categoryId];
      while (queue.length) {
        const current = queue.shift();
        for (const childId of childrenMap.get(current) || []) {
          if (result.has(childId)) continue;
          result.add(childId);
          queue.push(childId);
        }
      }
      return result;
    }

    function rebuildView() {
      const filterId = state.filterCategoryId;
      let nodes = state.rawNodes;
      let edges = state.rawEdges;
      if (filterId) {
        const subtree = collectSubtreeCategoryIds(filterId, edges);
        const siteIds = new Set();
        for (const e of edges) {
          if (e.target.startsWith('site:') && subtree.has(e.source)) siteIds.add(e.target);
        }
        nodes = nodes.filter(function (n) {
          return (n.kind === 'category' && subtree.has(n.id)) ||
                 (n.kind === 'site' && siteIds.has(n.id));
        });
        const kept = new Set(nodes.map(function (n) { return n.id; }));
        edges = edges.filter(function (e) { return kept.has(e.source) && kept.has(e.target); });
      }
      buildGraph({ nodes: nodes, edges: edges });
    }

    function buildGraph(data) {
      // 预建 degree map，避免对每个节点遍历全部 edges 的 O(n×m) 开销
      const degreeMap = new Map();
      for (const e of data.edges) {
        degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
        degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
      }
      const nodes = data.nodes.map(function (node, index) {
        // 黄金角螺旋作为初始位置，避免开局全部重叠
        const angle = index * 2.399963;
        const radius = 18 * Math.sqrt(index);
        const degree = degreeMap.get(node.id) || 0;
        return Object.assign({}, node, {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
          degree: degree,
          r: node.kind === 'category'
            ? 8 + Math.min(8, Math.sqrt(degree) * 1.6)
            : Math.max(3.5 + Math.min(4, Math.sqrt(degree)), SITE_ICON_SIZE / 2 + 2),
        });
      });
      for (const node of nodes) attachIcon(node, schedule);
      const byId = new Map(nodes.map(function (n) { return [n.id, n]; }));
      state.nodes = nodes;
      state.edges = (data.edges || []).flatMap(function (e) {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        return a && b ? [{ a: a, b: b }] : [];
      });
      state.frame = (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
        ? PHYSICS_FRAME_LIMIT
        : 0;
      schedule();
    }

    function resolveCategoryLevels(nodes, edges) {
      const parentMap = new Map();
      for (const e of edges) {
        if (typeof e.source === 'string' && typeof e.target === 'string' &&
            e.source.startsWith('cat:') && e.target.startsWith('cat:')) {
          parentMap.set(e.target, e.source);
        }
      }
      const memo = new Map();
      function getLevel(catId, visited = new Set()) {
        if (memo.has(catId)) return memo.get(catId);
        const parentId = parentMap.get(catId);
        if (!parentId || visited.has(catId)) {
          memo.set(catId, 1);
          return 1;
        }
        visited.add(catId);
        const lvl = getLevel(parentId, visited) + 1;
        memo.set(catId, lvl);
        return lvl;
      }
      for (const n of nodes) {
        if (n.kind === 'category') {
          n.level = Number(n.level) > 0 ? Number(n.level) : getLevel(n.id);
        }
      }
    }

    function setData(data) {
      state.rawNodes = (data.nodes || []).slice();
      state.rawEdges = (data.edges || []).slice();
      resolveCategoryLevels(state.rawNodes, state.rawEdges);
      state.filterCategoryId = null;
      rebuildView();
    }

    function filterByCategory(categoryId) {
      // categoryId 形如 'cat:123'；空值恢复全图
      const next = categoryId || null;
      if (next === (state.filterCategoryId || null)) return false;
      state.filterCategoryId = next;
      rebuildView();
      return true;
    }

    function getFilterCategoryId() {
      return state.filterCategoryId || null;
    }

    function getParentCategory(categoryId) {
      // 在原始 edges 中查找 categoryId 的父级分类
      if (!categoryId) return null;
      for (const e of state.rawEdges) {
        if (e.target === categoryId && e.source.startsWith('cat:')) return e.source;
      }
      return null;
    }

    function getColors() {
      const dark = document.documentElement.classList.contains('dark');
      return dark
        ? {
            edge: 'rgba(148, 163, 184, 0.35)',
            site: '#64748b',
            category: '#7c9cc4',
            categoryLevels: [
              '#60a5fa', // 1级: 明亮天蓝
              '#2dd4bf', // 2级: 清新青绿
              '#fbbf24', // 3级: 温暖琥珀
              '#a78bfa', // 4级: 柔和紫罗兰
              '#f43f5e', // 5级及以上: 醒目玫瑰红
            ],
            accent: '#60a5fa',
            chip: '#1e293b',
            text: 'rgba(226, 232, 240, 0.75)',
          }
        : {
            edge: 'rgba(100, 116, 139, 0.3)',
            site: '#94a3b8',
            category: '#416d9d',
            categoryLevels: [
              '#2563eb', // 1级: 经典皇家蓝
              '#0d9488', // 2级: 沉稳蓝绿
              '#d97706', // 3级: 活力暖琥珀
              '#7c3aed', // 4级: 优雅紫罗兰
              '#e11d48', // 5级及以上: 鲜艳玫瑰红
            ],
            accent: '#2f5d8a',
            chip: '#f1f5f9',
            text: 'rgba(51, 65, 85, 0.75)',
          };
    }

    function getCategoryColor(colors, level) {
      const clamped = Math.min(5, Math.max(1, Number(level) || 1));
      return (colors.categoryLevels && colors.categoryLevels[clamped - 1]) || colors.category;
    }

    function simulate() {
      const nodes = state.nodes;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < 0.01) {
            dx = (Math.random() - 0.5) * 0.6;
            dy = (Math.random() - 0.5) * 0.6;
            distanceSquared = 0.36;
          }
          if (distanceSquared > 120000) continue;
          const distance = Math.sqrt(distanceSquared);
          const force = REPULSION / distanceSquared;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
        // 向心力，防止图无限发散
        a.vx -= a.x * 0.0022;
        a.vy -= a.y * 0.0022;
      }
      for (const edge of state.edges) {
        const dx = edge.b.x - edge.a.x;
        const dy = edge.b.y - edge.a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const force = (distance - LINK_DISTANCE) * 0.008;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        edge.a.vx += fx; edge.a.vy += fy;
        edge.b.vx -= fx; edge.b.vy -= fy;
      }
      let movement = 0;
      for (const node of nodes) {
        if (state.dragging && state.dragging.node === node) continue;
        node.vx *= 0.86;
        node.vy *= 0.86;
        const moveX = Math.max(-8, Math.min(8, node.vx));
        const moveY = Math.max(-8, Math.min(8, node.vy));
        node.x += moveX;
        node.y += moveY;
        movement += Math.abs(moveX) + Math.abs(moveY);
      }
      // 足够稳定后提前冻结，停止消耗 CPU
      if (state.frame > 90 && movement < nodes.length * 0.01) {
        state.frame = PHYSICS_FRAME_LIMIT;
      }
    }

    function draw() {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      const colors = getColors();
      const emphasizedId = state.hoverNode ? state.hoverNode.id : null;

      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.save();
      ctx.translate(state.offsetX, state.offsetY);
      ctx.scale(state.scale, state.scale);

      ctx.lineWidth = 1 / state.scale;
      for (const edge of state.edges) {
        const related = emphasizedId && (emphasizedId === edge.a.id || emphasizedId === edge.b.id);
        ctx.strokeStyle = related ? colors.accent : colors.edge;
        ctx.globalAlpha = related ? 0.9 : (emphasizedId ? 0.12 : 0.5);
        ctx.beginPath();
        ctx.moveTo(edge.a.x, edge.a.y);
        ctx.lineTo(edge.b.x, edge.b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      for (const node of state.nodes) {
        const emphasized = node.id === emphasizedId;
        ctx.globalAlpha = emphasizedId && !emphasized ? 0.34 : 1;
        if (node.kind === 'site' && node.icon) {
          // 圆形底板 + 居中图标；图标加载失败的节点保持纯圆形
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
          ctx.fillStyle = emphasized ? colors.accent : colors.chip;
          ctx.fill();
          ctx.save();
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.r - 1.5 / state.scale, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(node.icon, node.x - SITE_ICON_SIZE / 2, node.y - SITE_ICON_SIZE / 2, SITE_ICON_SIZE, SITE_ICON_SIZE);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
          ctx.fillStyle = emphasized
            ? colors.accent
            : (node.kind === 'category' ? getCategoryColor(colors, node.level) : colors.site);
          ctx.fill();
        }
        if (emphasized) {
          ctx.strokeStyle = colors.accent;
          ctx.globalAlpha = 0.4;
          ctx.lineWidth = 3 / state.scale;
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // 缩放过小只画悬停标签，避免文字糊成一片
      if (state.scale > 0.55 || emphasizedId) {
        ctx.font = (11 / state.scale) + 'px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        for (const node of state.nodes) {
          const emphasized = node.id === emphasizedId;
          const isHub = node.kind === 'category';
          if (!emphasized && !isHub && state.scale < 1.1) continue;
          ctx.fillStyle = emphasized ? colors.accent : colors.text;
          ctx.globalAlpha = emphasized ? 1 : (emphasizedId ? 0.26 : 0.85);
          const label = node.title.length > 16 ? node.title.slice(0, 16) + '…' : node.title;
          ctx.fillText(label, node.x, node.y + node.r + 12 / state.scale);
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    function tick() {
      state.raf = 0;
      if (state.destroyed) return;
      if (state.frame < PHYSICS_FRAME_LIMIT) {
        state.frame++;
        simulate();
      }
      draw();
      if (state.frame < PHYSICS_FRAME_LIMIT) schedule();
    }

    function schedule() {
      if (!state.raf && !state.destroyed) state.raf = requestAnimationFrame(tick);
    }

    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!state.offsetX && !state.offsetY) {
        state.offsetX = rect.width / 2;
        state.offsetY = rect.height / 2;
      }
      schedule();
    }

    function fit() {
      if (!state.nodes.length) return;
      const rect = canvas.getBoundingClientRect();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of state.nodes) {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      const width = Math.max(80, maxX - minX + 80);
      const height = Math.max(80, maxY - minY + 80);
      state.scale = Math.min(2.5, Math.max(0.2, Math.min(rect.width / width, rect.height / height)));
      state.offsetX = rect.width / 2 - ((minX + maxX) / 2) * state.scale;
      state.offsetY = rect.height / 2 - ((minY + maxY) / 2) * state.scale;
      schedule();
    }

    function toWorld(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left - state.offsetX) / state.scale,
        y: (clientY - rect.top - state.offsetY) / state.scale,
      };
    }

    function nodeAt(x, y) {
      for (let i = state.nodes.length - 1; i >= 0; i--) {
        const node = state.nodes[i];
        if (Math.hypot(node.x - x, node.y - y) <= node.r + 7) return node;
      }
      return null;
    }

    function zoomAt(clientX, clientY, deltaY) {
      if (!Number.isFinite(deltaY) || deltaY === 0) return;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const next = Math.min(4, Math.max(0.2, state.scale * (deltaY > 0 ? 0.92 : 1.08)));
      if (next === state.scale) return;
      state.offsetX = x - ((x - state.offsetX) / state.scale) * next;
      state.offsetY = y - ((y - state.offsetY) / state.scale) * next;
      state.scale = next;
      schedule();
    }

    function beginDrag(clientX, clientY) {
      const point = toWorld(clientX, clientY);
      const node = nodeAt(point.x, point.y);
      state.dragging = { node: node, startX: clientX, startY: clientY, ox: state.offsetX, oy: state.offsetY };
      return node;
    }

    function moveDrag(clientX, clientY) {
      const point = toWorld(clientX, clientY);
      if (state.dragging) {
        if (state.dragging.node) {
          state.dragging.node.x = point.x;
          state.dragging.node.y = point.y;
          state.dragging.node.vx = 0;
          state.dragging.node.vy = 0;
          // 拖动后给物理系统一点余量做局部稳定
          state.frame = Math.min(state.frame, PHYSICS_FRAME_LIMIT - 100);
        } else {
          state.offsetX = state.dragging.ox + clientX - state.dragging.startX;
          state.offsetY = state.dragging.oy + clientY - state.dragging.startY;
        }
        schedule();
        return null;
      }
      const node = nodeAt(point.x, point.y);
      if ((state.hoverNode && state.hoverNode.id) !== (node && node.id)) {
        state.hoverNode = node;
        schedule();
      }
      return node;
    }

    function endDrag(clientX, clientY) {
      const drag = state.dragging;
      state.dragging = null;
      if (!drag) return null;
      const moved = Math.abs(clientX - drag.startX) + Math.abs(clientY - drag.startY);
      // 位移小于阈值视为点击，返回被点击节点
      return drag.node && moved < 5 ? drag.node : null;
    }

    function clearHover() {
      state.dragging = null;
      state.hoverNode = null;
      schedule();
    }

    function destroy() {
      state.destroyed = true;
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }

    return {
      setData: setData,
      filterByCategory: filterByCategory,
      getFilterCategoryId: getFilterCategoryId,
      getParentCategory: getParentCategory,
      resize: resize,
      fit: fit,
      schedule: schedule,
      zoomAt: zoomAt,
      beginDrag: beginDrag,
      moveDrag: moveDrag,
      endDrag: endDrag,
      clearHover: clearHover,
      destroy: destroy,
      getHoverNode: function () { return state.hoverNode; },
      hasNodes: function () { return state.nodes.length > 0; },
      getNodes: function () { return state.nodes; },
      getNodeById: function (id) {
        return state.rawNodes.find(function (node) { return node.id === id; }) || null;
      },
      getNodeCounts: function () {
        let catCount = 0;
        let siteCount = 0;
        for (const n of state.nodes) {
          if (n.kind === 'site') siteCount++;
          else catCount++;
        }
        return { catCount: catCount, siteCount: siteCount };
      },
      getColors: getColors,
      getCategoryColor: function (level) {
        return getCategoryColor(getColors(), level);
      },
      // 仅供自动化测试与调试读取内部坐标映射
      _debug: {
        toClient: function (wx, wy) {
          const rect = canvas.getBoundingClientRect();
          return { x: rect.left + wx * state.scale + state.offsetX, y: rect.top + wy * state.scale + state.offsetY };
        },
      },
    };
  }

  Home.createGraphEngine = createGraphEngine;
  Home.getCategoryColor = function (level) {
    const dark = document.documentElement.classList.contains('dark');
    const levels = dark
      ? ['#60a5fa', '#2dd4bf', '#fbbf24', '#a78bfa', '#f43f5e']
      : ['#2563eb', '#0d9488', '#d97706', '#7c3aed', '#e11d48'];
    const clamped = Math.min(5, Math.max(1, Number(level) || 1));
    return levels[clamped - 1];
  };
})();
