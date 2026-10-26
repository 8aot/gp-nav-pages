(() => {
  const modal = document.getElementById('friendLinksModal');
  const openBtn = document.getElementById('openFriendLinks');
  const closeBtn = document.getElementById('closeFriendLinks');
  const grid = document.getElementById('friendLinksGrid');
  const source = document.querySelector('.nav-friend-links');
  if (!modal || !openBtn || !closeBtn || !grid || !source) return;

  const links = Array.from(source.querySelectorAll('a[href]')).filter(link => {
    try { return ['http:', 'https:'].includes(new URL(link.href).protocol); } catch (_) { return false; }
  });
  links.forEach(link => {
    const url = link.href;
    const name = (link.textContent || '').trim();
    if (!name) return;
    const card = document.createElement('a');
    card.className = 'friend-link-card';
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    const icon = document.createElement('span');
    icon.className = 'friend-link-card-icon';
    icon.textContent = Array.from(name)[0].toUpperCase();
    const label = document.createElement('span');
    label.className = 'friend-link-card-name';
    label.textContent = name;
    card.append(icon, label);
    grid.appendChild(card);
  });
  if (!grid.children.length) {
    const empty = document.createElement('p');
    empty.className = 'friend-links-empty';
    empty.textContent = '暂时还没有友情链接';
    grid.appendChild(empty);
  }

  function open() {
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('friend-links-modal-open');
    closeBtn.focus();
  }
  function close() {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('friend-links-modal-open');
    openBtn.focus();
  }
  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && modal.classList.contains('is-open')) close(); });
})();
