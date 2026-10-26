(() => {
  const $ = id => document.getElementById(id);
  const modal = $('friendLinksModal'), content = $('friendLinksContent'), passModal = $('friendPasswordModal');
  if (!modal || !$('openFriendLinks')) return;
  let links = [], pending = null;
  const show = el => { el.classList.remove('hidden'); el.classList.add('flex'); };
  const hide = el => { el.classList.add('hidden'); el.classList.remove('flex'); };
  $('openFriendLinks').addEventListener('click', async () => {
    show(modal); content.innerHTML = '<p class="text-gray-500">正在加载...</p>';
    try { const r = await fetch('/api/friend-links'); const j = await r.json(); links = j.data || []; render(); }
    catch { content.innerHTML = '<p class="text-red-500">加载失败，请稍后重试。</p>'; }
  });
  $('closeFriendLinks').addEventListener('click', () => hide(modal));
  modal.addEventListener('click', e => { if (e.target === modal) hide(modal); });
  $('cancelFriendPassword').addEventListener('click', () => hide(passModal));
  function render() {
    if (!links.length) { content.innerHTML = '<p class="text-gray-500">暂无友情链接，请在后台添加。</p>'; return; }
    const groups = new Map(); links.forEach(x => { const c = x.category || '默认'; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(x); });
    content.innerHTML = [...groups].map(([category, items]) => `<section class="mb-6"><h3 class="text-lg font-bold mb-3">${esc(category)}</h3><div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">${items.map(x => `<button data-friend-id="${esc(x.id)}" class="friend-link-tile flex flex-col items-center justify-center gap-2 rounded-2xl border border-white/30 bg-gray-200/50 dark:bg-gray-700/50 hover:bg-white/70 dark:hover:bg-gray-600/70 p-4 min-h-[84px] transition"><span class="flex items-center justify-center rounded-lg bg-white dark:bg-gray-100 text-gray-600 font-bold w-12 h-12">${esc((x.title||'?').slice(0,1))}</span><span class="text-sm">${esc(x.title)}</span></button>`).join('')}</div></section>`).join('');
    content.querySelectorAll('[data-friend-id]').forEach(b => b.addEventListener('click', () => { const item = links.find(x => String(x.id) === b.dataset.friendId); if (!item) return; if (item.hasPassword) { pending = item; $('friendPasswordTitle').textContent = `访问「${item.title}」需要密码`; $('friendPasswordInput').value=''; $('friendPasswordError').textContent=''; show(passModal); $('friendPasswordInput').focus(); } else window.open(item.url, '_blank', 'noopener,noreferrer'); }));
  }
  $('friendPasswordForm').addEventListener('submit', async e => { e.preventDefault(); if (!pending) return; try { const r = await fetch('/api/friend-links/verify', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:pending.id,password:$('friendPasswordInput').value})}); const j=await r.json(); if (!r.ok || j.code !== 200) throw new Error(j.message || '密码错误'); hide(passModal); window.open(j.data.url, '_blank', 'noopener,noreferrer'); pending=null; } catch(err) { $('friendPasswordError').textContent=err.message || '验证失败'; } });
  function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
})();
