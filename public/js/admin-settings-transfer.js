(() => {
  const backupBtn = document.getElementById('backupCurrentSettingsBtn');
  const importBtn = document.getElementById('importSettingsBtn');
  const fileInput = document.getElementById('importSettingsFile');
  const status = document.getElementById('settingsBackupStatus');
  if (!backupBtn || !importBtn || !fileInput || !status) return;

  function message(text, error = false) {
    status.textContent = text;
    status.style.display = 'block';
    status.style.color = error ? '#dc2626' : '';
  }
  async function responseJson(response) {
    let data;
    try { data = await response.json(); } catch (_) { throw new Error('服务器返回的数据无法解析'); }
    if (!response.ok || (data.code && data.code !== 200)) throw new Error(data.message || `请求失败（${response.status}）`);
    return data;
  }
  backupBtn.addEventListener('click', async () => {
    backupBtn.disabled = true;
    try {
      const data = await responseJson(await fetch('/api/settings', { credentials: 'same-origin' }));
      const settings = data.data || {};
      const payload = { format: 'iori-nav-settings', version: 1, exportedAt: new Date().toISOString(), settings };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `iori-nav-settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      message('配置备份已下载。注意：API 密钥和 WebDAV 密码不会包含在备份中。');
    } catch (error) { message(`备份失败：${error.message}`, true); }
    finally { backupBtn.disabled = false; }
  });
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('设置文件不能超过 2 MB');
      const parsed = JSON.parse(await file.text());
      const settings = parsed?.format === 'iori-nav-settings' ? parsed.settings : parsed?.settings || parsed;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('文件格式不正确，请选择导航页设置 JSON 文件');
      // 备份文件来自 /api/settings；过滤状态标记与敏感凭据，其他字段交由服务端 schema 校验。
      const forbidden = new Set(['has_api_key', 'has_webdav_password', 'debug_api_key_info', 'apiKey', 'webdav_password']);
      const clean = {};
      Object.entries(settings).forEach(([key, value]) => {
        if (!forbidden.has(key) && typeof key === 'string') clean[key] = value;
      });
      if (!Object.keys(clean).length) throw new Error('文件中没有可导入的站点设置');
      if (!confirm(`将导入 ${Object.keys(clean).length} 项设置，并覆盖这些设置的当前值。建议先备份当前配置。继续吗？`)) return;
      importBtn.disabled = true;
      const result = await responseJson(await fetch('/api/settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clean)
      }));
      message('设置导入成功。刷新页面后即可查看效果。');
    } catch (error) { message(`导入失败：${error.message}`, true); }
    finally { importBtn.disabled = false; fileInput.value = ''; }
  });
})();
