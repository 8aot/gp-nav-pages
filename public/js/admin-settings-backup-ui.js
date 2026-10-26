(function () {
  const ns = window.AdminSettings = window.AdminSettings || {};
  let cachedRefs = null;

  function getBackupRefs() {
    if (cachedRefs) return cachedRefs;

    const refs = {
      urlInput: document.getElementById('webdavUrl'),
      usernameInput: document.getElementById('webdavUsername'),
      passwordInput: document.getElementById('webdavPassword'),
      clearPasswordBtn: document.getElementById('webdavClearPasswordBtn'),
      dirInput: document.getElementById('webdavDir'),
      backupBtn: document.getElementById('webdavBackupBtn'),
      statusEl: document.getElementById('webdavBackupStatus'),
      listBtn: document.getElementById('webdavListBtn'),
      restoreModal: document.getElementById('webdavRestoreModal'),
      restoreLoading: document.getElementById('webdavRestoreLoading'),
      restoreError: document.getElementById('webdavRestoreError'),
      listWrap: document.getElementById('webdavBackupList'),
      restoreBtn: document.getElementById('webdavRestoreBtn'),
      closeRestoreBtn: document.getElementById('closeWebdavRestoreModal'),
      cancelRestoreBtn: document.getElementById('cancelWebdavRestoreBtn'),
      restoreStatusEl: document.getElementById('webdavRestoreStatus'),
      deleteConfirmModal: document.getElementById('webdavDeleteConfirmModal'),
      closeDeleteConfirmBtn: document.getElementById('closeWebdavDeleteConfirmModal'),
      cancelDeleteBtn: document.getElementById('cancelWebdavDeleteBtn'),
      confirmDeleteBtn: document.getElementById('confirmWebdavDeleteBtn'),
      confirmTitle: document.getElementById('webdavConfirmTitle'),
      confirmMessage: document.getElementById('webdavConfirmMessage'),
      confirmDescription: document.getElementById('webdavConfirmDescription'),
    };

    // 可能在元素就绪前被调用，拿不全就不缓存。
    if (refs.backupBtn) cachedRefs = refs;
    return refs;
  }

  function setStatus(el, text, type) {
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    el.style.color = type === 'error' ? '#b42318' : (type === 'success' ? '#1a7f37' : '');
  }

  function showStatus(text, type) {
    setStatus(getBackupRefs().statusEl, text, type);
  }

  function showRestoreStatus(text, type) {
    setStatus(getBackupRefs().restoreStatusEl, text, type);
  }

  function syncPasswordField(currentSettings) {
    const { passwordInput, clearPasswordBtn } = getBackupRefs();
    const configured = !!currentSettings?.has_webdav_password;
    if (passwordInput) {
      passwordInput.value = '';
      passwordInput.placeholder = configured ? '已配置 (如需修改请直接输入)' : '请输入密码';
    }
    if (clearPasswordBtn) {
      clearPasswordBtn.style.display = configured ? 'inline' : 'none';
    }
  }

  function setRestoreError(text) {
    const { restoreError } = getBackupRefs();
    if (!restoreError) return;
    if (!text) {
      restoreError.style.display = 'none';
      restoreError.textContent = '';
      return;
    }
    restoreError.textContent = text;
    restoreError.style.display = 'block';
  }

  function unlockBodyScrollWhenNoModalIsOpen() {
    const modals = document.querySelectorAll?.('.modal') || [];
    const stillOpen = Array.from(modals).some(modal => (
      modal.style?.display && modal.style.display !== 'none'
    ));
    if (!stillOpen) document.body.classList.remove('modal-open');
  }

  function openRestoreModal() {
    const { restoreModal, restoreLoading, listWrap, restoreBtn, restoreStatusEl } = getBackupRefs();
    if (!restoreModal) return;

    setRestoreError('');
    if (restoreStatusEl) {
      restoreStatusEl.textContent = '';
      restoreStatusEl.style.display = 'none';
    }
    if (listWrap) listWrap.innerHTML = '';
    if (restoreLoading) {
      restoreLoading.textContent = '正在获取备份列表...';
      restoreLoading.style.display = 'block';
    }
    if (restoreBtn) restoreBtn.disabled = true;
    restoreModal.style.display = 'block';
    document.body.classList.add('modal-open');
  }

  function closeRestoreModal() {
    const { restoreModal } = getBackupRefs();
    if (restoreModal) restoreModal.style.display = 'none';
    unlockBodyScrollWhenNoModalIsOpen();
  }

  function openConfirmModal({ title, message, description, confirmLabel }) {
    const refs = getBackupRefs();
    if (!refs.deleteConfirmModal) return false;

    if (refs.confirmTitle) refs.confirmTitle.textContent = title;
    if (refs.confirmMessage) refs.confirmMessage.textContent = message;
    if (refs.confirmDescription) refs.confirmDescription.textContent = description;
    if (refs.confirmDeleteBtn) refs.confirmDeleteBtn.textContent = confirmLabel;
    refs.deleteConfirmModal.style.display = 'block';
    document.body.classList.add('modal-open');
    return true;
  }

  function closeConfirmModal() {
    const { deleteConfirmModal } = getBackupRefs();
    if (deleteConfirmModal) deleteConfirmModal.style.display = 'none';
    unlockBodyScrollWhenNoModalIsOpen();
  }

  function formatBackupLabel(backup) {
    return backup.backupTime
      ? `备份时间 ${backup.backupTime.replace('T', ' ').replace('Z', ' UTC')}`
      : backup.filename;
  }

  function renderBackupList(backups, handlers) {
    const { listWrap, restoreBtn } = getBackupRefs();
    if (!listWrap) return [];

    listWrap.innerHTML = backups.map(backup => {
      const size = backup.size ? `${(backup.size / 1024).toFixed(1)} KB` : '未知大小';
      const safeFilename = window.escapeHTML(backup.filename);
      return `<div class="library-item webdav-backup-item" data-filename="${safeFilename}">
        <button type="button" class="webdav-backup-select">
          <span class="library-name">${window.escapeHTML(formatBackupLabel(backup))}</span>
          <span class="library-desc webdav-backup-meta">
            <span class="webdav-backup-filename">${safeFilename}</span>
            <span aria-hidden="true">·</span>
            <span class="webdav-backup-size">${size}</span>
          </span>
        </button>
        <button type="button" class="webdav-backup-delete p-1.5 bg-red-50 text-red-600 rounded-full hover:bg-red-100 transition-colors shadow-sm" title="删除备份"
          aria-label="删除备份 ${safeFilename}">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>`;
    }).join('');

    const items = listWrap.querySelectorAll('.webdav-backup-item');
    items.forEach(item => {
      item.querySelector('.webdav-backup-select')?.addEventListener('click', () => handlers.onSelect(item));
      item.querySelector('.webdav-backup-delete')?.addEventListener('click', () => handlers.onDelete(item));
    });
    if (items.length === 0 && restoreBtn) restoreBtn.disabled = true;
    return items;
  }

  function showEmptyBackupList() {
    const { listWrap, restoreBtn } = getBackupRefs();
    if (restoreBtn) restoreBtn.disabled = true;
    if (listWrap) {
      listWrap.innerHTML = '<div class="webdav-backup-empty">暂无备份文件，请先执行一次备份</div>';
    }
  }

  ns.backupUi = {
    getBackupRefs,
    showStatus,
    showRestoreStatus,
    syncPasswordField,
    setRestoreError,
    openRestoreModal,
    closeRestoreModal,
    openConfirmModal,
    closeConfirmModal,
    renderBackupList,
    showEmptyBackupList,
  };
})();
