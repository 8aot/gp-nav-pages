// public/js/admin-graph.js
// 后台「关系图谱」页签：数据加载、canvas 面板与交互事件绑定。
// 物理模拟与绘制复用 home-graph-engine.js（IoriHome.createGraphEngine）。
(function () {
  const Home = window.IoriHome = window.IoriHome || {};

  function isSafeHttpUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  const state = {
    engine: null,
    loaded: false,
    loading: false,
    bound: false,
    meta: null,
    filterWarning: '',
    fallbackFullscreen: false,
  };

  function els() {
    return {
      container: document.getElementById('graphContainer'),
      canvas: document.getElementById('graphCanvas'),
      loading: document.getElementById('graphLoading'),
      tooltip: document.getElementById('graphTooltip'),
      stats: document.getElementById('graphStats'),
      statsScope: document.getElementById('graphStatsScope'),
      categoryCount: document.getElementById('graphCategoryCount'),
      bookmarkCount: document.getElementById('graphBookmarkCount'),
      statsNote: document.getElementById('graphStatsNote'),
      back: document.getElementById('graphBack'),
      up: document.getElementById('graphUp'),
      navSep: document.getElementById('graphNavSep'),
      fullscreen: document.getElementById('graphFullscreen'),
      fullscreenEnterIcon: document.querySelector('.graph-fullscreen-enter-icon'),
      fullscreenExitIcon: document.querySelector('.graph-fullscreen-exit-icon'),
    };
  }

  function applyFilter(categoryId) {
    if (!state.engine || !state.loaded) return;
    const requestedNode = categoryId ? state.engine.getNodeById(categoryId) : null;
    state.filterWarning = categoryId && !requestedNode
      ? `当前分类未包含在图谱，已显示完整图谱（图谱仅加载前 ${Number(state.meta?.categoryLimit || 0).toLocaleString('zh-CN')} 个分类）`
      : '';
    state.engine.filterByCategory(requestedNode ? categoryId : null);
    state.engine.clearHover();
    updateTooltip(null);
    refreshStats();
    // 等过滤后的物理模拟展开再适配视图
    window.setTimeout(function () { state.engine && state.engine.fit(); }, 150);
  }

  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function isFullscreen() {
    const { container } = els();
    return state.fallbackFullscreen || Boolean(container && getFullscreenElement() === container);
  }

  function resizeGraph(fit) {
    if (!state.engine) return;
    window.requestAnimationFrame(function () {
      if (!state.engine) return;
      state.engine.resize();
      if (fit) state.engine.fit();
    });
  }

  function updateFullscreenButton() {
    const { fullscreen, fullscreenEnterIcon, fullscreenExitIcon } = els();
    const active = isFullscreen();
    if (fullscreenEnterIcon) fullscreenEnterIcon.classList.toggle('hidden', active);
    if (fullscreenExitIcon) fullscreenExitIcon.classList.toggle('hidden', !active);
    if (fullscreen) {
      fullscreen.title = active ? '退出全屏' : '全屏';
      fullscreen.setAttribute('aria-label', active ? '退出全屏' : '全屏');
    }
    document.documentElement.classList.toggle('graph-fullscreen-open', active);
  }

  function enterFallbackFullscreen() {
    const { container } = els();
    if (!container) return;
    state.fallbackFullscreen = true;
    container.classList.add('graph-fullscreen');
    updateFullscreenButton();
    resizeGraph(true);
  }

  function exitFallbackFullscreen() {
    const { container } = els();
    state.fallbackFullscreen = false;
    container?.classList.remove('graph-fullscreen');
    updateFullscreenButton();
    resizeGraph(true);
  }

  async function toggleFullscreen() {
    const { container } = els();
    if (!container) return;

    if (isFullscreen()) {
      if (getFullscreenElement() === container) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
      } else {
        exitFallbackFullscreen();
      }
      return;
    }

    const request = container.requestFullscreen || container.webkitRequestFullscreen;
    if (!request) {
      enterFallbackFullscreen();
      return;
    }

    try {
      await request.call(container);
    } catch (e) {
      // 浏览器拒绝全屏请求时仍提供固定定位的兼容模式。
      enterFallbackFullscreen();
    }
  }

  function refreshNavigation() {
    if (!state.engine) return;
    const { back, up, navSep } = els();
    const currentId = state.engine.getFilterCategoryId();
    const parentId = currentId ? state.engine.getParentCategory(currentId) : null;
    const currentNode = currentId ? state.engine.getNodeById(currentId) : null;
    const parentNode = parentId ? state.engine.getNodeById(parentId) : null;

    back?.classList.toggle('hidden', !currentId);
    up?.classList.toggle('hidden', !currentId);
    navSep?.classList.toggle('hidden', !currentId);

    if (up && currentId) {
      const label = parentNode ? `返回上一级：${parentNode.title}` : '返回完整图谱';
      up.title = label;
      up.setAttribute('aria-label', label);
    }
    if (back && currentNode) {
      const label = `返回完整图谱（当前：${currentNode.title}）`;
      back.title = label;
      back.setAttribute('aria-label', label);
    }
  }

  // 反向同步书签列表的分类过滤下拉框（trigger 文案 + change 事件，书签列表随动过滤）
  function syncCategoryDropdown(categoryId) {
    const input = document.getElementById('categoryFilter');
    if (!input) return false;
    const wrapper = document.getElementById('categoryFilterWrapper');
    const trigger = wrapper && wrapper.querySelector('.custom-dropdown-trigger');
    const rawId = categoryId ? categoryId.slice(4) : '';
    const changed = String(input.value || '') !== String(rawId);

    let label = '所有分类';
    if (rawId) {
      const node = state.engine.getNodeById(categoryId);
      label = (node && node.title) || label;
    }
    input.value = rawId;
    if (trigger) trigger.textContent = label;
    if (changed) input.dispatchEvent(new Event('change'));
    return changed;
  }

  function navigateTo(categoryId) {
    if (!state.engine || !state.loaded) return;
    if (!syncCategoryDropdown(categoryId)) applyFilter(categoryId);
  }

  function updateTooltip(node) {
    const { tooltip } = els();
    if (!tooltip) return;
    if (!node) {
      tooltip.classList.add('hidden');
      return;
    }
    tooltip.textContent = node.kind === 'category'
      ? `${node.title}（双击进入该分类）`
      : node.title + '（双击打开链接）';
    tooltip.classList.remove('hidden');
  }

  function bindOnce() {
    if (state.bound) return;
    state.bound = true;
    const { canvas, container } = els();
    if (!canvas) return;

    document.getElementById('graphFit')?.addEventListener('click', function () {
      state.engine && state.engine.fit();
    });
    document.getElementById('graphBack')?.addEventListener('click', function () {
      navigateTo(null);
    });
    document.getElementById('graphUp')?.addEventListener('click', function () {
      if (!state.engine) return;
      const currentId = state.engine.getFilterCategoryId();
      navigateTo(currentId ? state.engine.getParentCategory(currentId) : null);
    });
    document.getElementById('graphFullscreen')?.addEventListener('click', function () {
      toggleFullscreen();
    });
    document.getElementById('graphZoomIn')?.addEventListener('click', function () {
      if (!state.engine) return;
      const rect = canvas.getBoundingClientRect();
      state.engine.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, -100);
    });
    document.getElementById('graphZoomOut')?.addEventListener('click', function () {
      if (!state.engine) return;
      const rect = canvas.getBoundingClientRect();
      state.engine.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 100);
    });

    canvas.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || !state.engine) return;
      canvas.setPointerCapture(event.pointerId);
      state.engine.beginDrag(event.clientX, event.clientY);
    });
    canvas.addEventListener('pointermove', function (event) {
      if (!state.engine) return;
      const hover = state.engine.moveDrag(event.clientX, event.clientY);
      updateTooltip(hover || state.engine.getHoverNode());
    });
    canvas.addEventListener('pointerup', function (event) {
      state.engine && state.engine.endDrag(event.clientX, event.clientY);
    });
    canvas.addEventListener('pointercancel', function () {
      if (!state.engine) return;
      state.engine.clearHover();
      updateTooltip(null);
    });
    canvas.addEventListener('pointerleave', function () {
      if (!state.engine) return;
      state.engine.clearHover();
      updateTooltip(null);
    });
    canvas.addEventListener('dblclick', function (event) {
      if (!state.engine) return;
      state.engine.beginDrag(event.clientX, event.clientY);
      const node = state.engine.endDrag(event.clientX, event.clientY);
      if (!node) return;
      if (node.kind === 'category') {
        // 双击分类节点：进入该分类的子图谱，并同步书签列表的分类过滤
        navigateTo(node.id);
      } else if (node.kind === 'site' && isSafeHttpUrl(node.url)) {
        window.open(node.url, '_blank', 'noopener,noreferrer');
      }
    });
    canvas.addEventListener('wheel', function (event) {
      if (!state.engine) return;
      event.preventDefault();
      state.engine.zoomAt(event.clientX, event.clientY, event.deltaY);
    }, { passive: false });

    window.addEventListener('resize', function () {
      const graphTab = document.getElementById('graph');
      if (!state.engine || !graphTab || !graphTab.classList.contains('active')) return;
      resizeGraph(true);
    });

    document.addEventListener('fullscreenchange', function () {
      updateFullscreenButton();
      resizeGraph(true);
    });
    document.addEventListener('webkitfullscreenchange', function () {
      updateFullscreenButton();
      resizeGraph(true);
    });
    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.fallbackFullscreen) exitFallbackFullscreen();
    });
    updateFullscreenButton();

    // 与书签列表的分类过滤下拉框联动：选中分类时只显示该分类子树
    const categoryFilter = document.getElementById('categoryFilter');
    if (categoryFilter) {
      categoryFilter.addEventListener('change', function () {
        applyFilter(categoryFilter.value ? 'cat:' + categoryFilter.value : null);
      });
    }
  }

  function refreshStats() {
    const { stats } = els();
    if (!stats || !state.engine) return;
    const counts = state.engine.getNodeCounts();
    const currentId = state.engine.getFilterCategoryId();
    const currentNode = currentId ? state.engine.getNodeById(currentId) : null;
    const { statsScope, categoryCount, bookmarkCount, statsNote } = els();
    if (statsScope) statsScope.textContent = currentNode ? currentNode.title : '全部图谱';
    if (categoryCount) categoryCount.textContent = counts.catCount.toLocaleString('zh-CN');
    if (bookmarkCount) bookmarkCount.textContent = counts.siteCount.toLocaleString('zh-CN');
    if (statsNote) {
      const notices = [];
      if (state.meta?.categoryTruncated) {
        notices.push(`分类已显示前 ${Number(state.meta.categoryLimit || 0).toLocaleString('zh-CN')} 个，共 ${Number(state.meta.totalCategories || 0).toLocaleString('zh-CN')} 个`);
      }
      if (state.meta?.truncated) {
        notices.push(`书签数据已显示前 ${Number(state.meta.limit || 0).toLocaleString('zh-CN')} 条，共 ${Number(state.meta.totalSites || 0).toLocaleString('zh-CN')} 条`);
      }
      if (state.filterWarning) {
        notices.unshift(state.filterWarning);
      }
      statsNote.textContent = notices.join('；');
      statsNote.classList.toggle('hidden', notices.length === 0);
    }
    stats.classList.add('is-visible');
    refreshNavigation();
  }

  function load(force) {
    if (state.loading || (state.loaded && !force)) return;
    const { canvas, loading } = els();
    if (!canvas || !loading) return;
    bindOnce();
    const hadLoadedGraph = state.loaded;
    state.loading = true;
    loading.textContent = state.loaded ? '正在刷新图谱…' : '正在构建图谱…';
    loading.classList.remove('hidden');

    if (!state.engine) {
      state.engine = Home.createGraphEngine(canvas);
    }
    state.engine.resize();

    fetch('/api/graph', { headers: { 'Accept': 'application/json' } })
      .then(async function (res) {
        if (!res.ok) {
          let msg = 'HTTP ' + res.status;
          try {
            const err = await res.json();
            if (err && err.message) msg = err.message;
          } catch (_) {}
          throw new Error(msg);
        }
        return res.json();
      })
      .then(function (payload) {
        const data = payload && payload.data;
        if (!data || !data.nodes || !data.nodes.length) {
          state.meta = data?.meta || null;
          state.engine.setData({ nodes: [], edges: [] });
          state.loaded = false;
          refreshStats();
          loading.textContent = '暂无数据，先添加一些分类和书签吧';
          loading.classList.remove('hidden');
          return;
        }
        state.meta = data.meta || null;
        const filterValue = document.getElementById('categoryFilter')?.value || '';
        state.engine.setData(data);
        state.loaded = true;
        // 进入页签时若已选中分类过滤，图谱同步到该分类子树
        if (filterValue) {
          applyFilter('cat:' + filterValue);
        } else {
          state.filterWarning = '';
        }
        refreshStats();
        loading.classList.add('hidden');
        // 等物理模拟稍微展开后再适配视图
        window.setTimeout(function () { state.engine && state.engine.fit(); }, 150);
      })
      .catch(function (e) {
        loading.textContent = '图谱加载失败：' + e.message;
        loading.classList.toggle('hidden', hadLoadedGraph);
      })
      .finally(function () {
        state.loading = false;
      });
  }

  window.AdminGraph = { load: load };
})();
