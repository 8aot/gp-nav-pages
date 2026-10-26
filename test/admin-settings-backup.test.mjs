import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

function readBackupSource() {
  return [
    'public/js/admin-settings-backup-ui.js',
    'public/js/admin-settings-backup.js',
  ].map(file => readFileSync(resolve(file), 'utf8')).join('\n');
}

test('backup frontend modules stay split and load in dependency order', () => {
  const files = [
    'public/js/admin-settings-backup-ui.js',
    'public/js/admin-settings-backup.js',
  ];
  for (const file of files) {
    const lineCount = readFileSync(resolve(file), 'utf8').split(/\r?\n/).length - 1;
    assert.ok(lineCount <= 500, `${file} 不应超过 500 行，当前 ${lineCount} 行`);
  }

  const html = readFileSync(resolve('public/admin/index.html'), 'utf8');
  assert.ok(
    html.indexOf('/js/admin-settings-backup-ui.js') < html.indexOf('/js/admin-settings-backup.js'),
    '备份 UI 依赖必须先于业务控制器加载'
  );
});

test('frontend admin-settings-backup.js parses and exposes backup module', () => {
  const source = readBackupSource();
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: 'public/js/admin-settings-backup.js' });
  assert.ok(sandbox.window.AdminSettings.backup);
  assert.equal(typeof sandbox.window.AdminSettings.backup.init, 'function');
  assert.equal(typeof sandbox.window.AdminSettings.backup.runBackup, 'function');
});

test('frontend backup module exposes list and restore entry points', () => {
  const source = readBackupSource();
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: 'public/js/admin-settings-backup.js' });
  assert.equal(typeof sandbox.window.AdminSettings.backup.fetchBackupList, 'function');
  assert.equal(typeof sandbox.window.AdminSettings.backup.restoreBackup, 'function');
  assert.equal(typeof sandbox.window.AdminSettings.backup.deleteBackup, 'function');
});

test('frontend restore accepts backups that contain only categories', () => {
  const source = readBackupSource();
  assert.match(source, /payload\.sites\.length === 0 && payload\.category\.length === 0/);
});

test('backup deletion uses the project confirmation modal before DELETE and shows an empty state', async () => {
  const source = readBackupSource();
  const messages = [];
  const requests = [];
  let removed = false;

  const makeEl = () => ({
    value: '', textContent: '', innerHTML: '', placeholder: '', disabled: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {} },
    setAttribute() {}, removeAttribute() {},
    addEventListener(type, fn) { (this._on ||= {})[type] = fn; },
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const nodes = {};
  const filename = 'iori-nav-backup-20260202-080000-000-20260202080000aaaaaaaaaaaaaaaaaa.json';
  const item = {
    dataset: { filename },
    querySelector: () => null,
    remove() { removed = true; },
  };

  const sandbox = {
    window: {
      showMessage: (message, type) => messages.push({ message, type }),
      AdminSettings: { currentSettings: {} },
    },
    document: {
      getElementById: id => (nodes[id] ||= makeEl()),
      querySelectorAll: () => [],
      body: { classList: { add() {}, remove() {} } },
    },
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ code: 200, data: { filename } }));
    },
    Response, Request, console,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'public/js/admin-settings-backup.js' });

  const backup = sandbox.window.AdminSettings.backup;
  backup.init();
  backup.requestDeleteBackup(filename, item);

  assert.equal(nodes.webdavDeleteConfirmModal.style.display, 'block');
  assert.equal(requests.length, 0, '确认前不应发送删除请求');

  await nodes.confirmWebdavDeleteBtn._on.click();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/api/backup/webdav?filename=${encodeURIComponent(filename)}`);
  assert.equal(requests[0].init.method, 'DELETE');
  assert.equal(removed, true);
  assert.equal(nodes.webdavRestoreBtn.disabled, true);
  assert.match(nodes.webdavBackupList.innerHTML, /暂无备份文件/);
  assert.deepEqual(messages, [{ message: '备份已删除', type: 'success' }]);
});

test('backup deletion reuses the bookmark-card delete icon and confirmation copy', () => {
  const backupSource = readBackupSource();
  const bookmarkSource = readFileSync(resolve('public/js/admin-bookmark-list.js'), 'utf8');
  const html = readFileSync(resolve('public/admin/index.html'), 'utf8');
  const deletePath = 'M6 18L18 6M6 6l12 12';
  const deleteClasses = 'p-1.5 bg-red-50 text-red-600 rounded-full hover:bg-red-100 transition-colors shadow-sm';

  assert.ok(bookmarkSource.includes(`d="${deletePath}"`));
  assert.ok(backupSource.includes(`d="${deletePath}"`));
  assert.ok(bookmarkSource.includes(deleteClasses));
  assert.ok(backupSource.includes(deleteClasses));
  assert.match(html, /id="webdavDeleteConfirmModal"[\s\S]*?确定要删除该备份吗？[\s\S]*?此操作无法撤销，请谨慎操作。/);
});

test('backup size stays visible when a long filename is truncated beside the delete icon', () => {
  const source = readBackupSource();
  const css = readFileSync(resolve('public/css/admin-forms.css'), 'utf8');

  assert.match(source, /webdav-backup-filename[\s\S]*?webdav-backup-size/);
  assert.match(css, /\.webdav-backup-filename\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /\.webdav-backup-size\s*\{[^}]*flex:\s*0 0 auto/s);
});

test('restore modal locks background scrolling like every other admin modal', async () => {
  const source = readBackupSource();
  const defaultsSource = readFileSync(resolve('public/js/admin-settings-defaults.js'), 'utf8');

  const makeEl = () => ({
    value: '', textContent: '', innerHTML: '', placeholder: '', disabled: false,
    style: {}, classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (this._on ||= {})[type] = fn; },
    querySelectorAll: () => [], appendChild() {},
  });
  const nodes = {};
  const bodyClasses = new Set();

  // 设置弹窗归 core 模块管，这里手动建出来模拟「恢复弹窗嵌在设置弹窗里打开」
  nodes.settingsModal = makeEl();
  nodes.settingsModal.style.display = 'none';

  const sandbox = {
    window: {
      showMessage() {},
      AdminSettings: {
        currentSettings: {
          has_webdav_password: true,
          webdav_url: 'https://dav.example.com/',
          webdav_username: 'u',
          webdav_dir: 'nav',
        },
      },
    },
    document: {
      getElementById: id => (nodes[id] ||= makeEl()),
      querySelector: () => null,
      // closeRestoreModal 靠它判断底层还有没有别的弹窗开着
      querySelectorAll: () => [nodes.settingsModal, nodes.webdavRestoreModal].filter(Boolean),
      addEventListener() {},
      createElement: makeEl,
      body: {
        classList: {
          add: c => bodyClasses.add(c),
          remove: c => bodyClasses.delete(c),
        },
      },
    },
    fetch: async () => new Response(JSON.stringify({ code: 200, data: { backups: [] } })),
    Response, Request, console,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(defaultsSource, sandbox, { filename: 'public/js/admin-settings-defaults.js' });
  vm.runInNewContext(source, sandbox, { filename: 'public/js/admin-settings-backup.js' });

  const backup = sandbox.window.AdminSettings.backup;
  backup.init();

  // 表单内容与已加载配置一致；模块仍会先保存当前可见目标，再读取列表。
  nodes.webdavUrl.value = 'https://dav.example.com/';
  nodes.webdavUsername.value = 'u';
  nodes.webdavDir.value = 'nav';

  // 上一轮恢复留下的背景提示不应在新一轮打开弹窗时残留
  nodes.webdavRestoreStatus.textContent = '上一轮恢复消息';
  nodes.webdavRestoreStatus.style.display = 'block';

  await backup.fetchBackupList();
  assert.equal(bodyClasses.has('modal-open'), true, '打开恢复弹窗应锁住背景滚动');
  assert.equal(nodes.webdavRestoreStatus.textContent, '', '打开恢复弹窗应清掉上一轮状态提示');
  assert.equal(nodes.webdavRestoreStatus.style.display, 'none', '打开恢复弹窗应隐藏背景状态提示');

  nodes.cancelWebdavRestoreBtn._on.click();
  assert.equal(bodyClasses.has('modal-open'), false, '关闭后应解锁背景滚动');

  // 底层设置弹窗仍开着时，关掉恢复弹窗不能把背景滚动放开
  nodes.settingsModal.style.display = 'block';
  await backup.fetchBackupList();
  nodes.cancelWebdavRestoreBtn._on.click();
  assert.equal(bodyClasses.has('modal-open'), true, '底层设置弹窗仍开着，不应解锁背景滚动');
});

test('frontend clear-password button confirms in the shared modal before clearing', async () => {
  const source = readBackupSource();

  const makeEl = () => ({
    value: '', textContent: '', innerHTML: '', placeholder: '', disabled: false,
    style: {}, classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (this._on ||= {})[type] = fn; },
    querySelectorAll: () => [], appendChild() {},
  });
  const nodes = {};
  const sent = [];

  const sandbox = {
    window: {
      showMessage() {},
      AdminSettings: { currentSettings: { has_webdav_password: true } },
    },
    document: {
      getElementById: id => (nodes[id] ||= makeEl()),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: makeEl,
      body: { classList: { add() {}, remove() {} } },
    },
    fetch: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ code: 200 }));
    },
    Response, Request, console,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'public/js/admin-settings-backup.js' });

  const backup = sandbox.window.AdminSettings.backup;
  backup.init();
  backup.syncPasswordField();
  assert.equal(nodes.webdavClearPasswordBtn.style.display, 'inline', '存过密码时应显示清除入口');

  nodes.webdavClearPasswordBtn._on.click();
  assert.equal(nodes.webdavDeleteConfirmModal.style.display, 'block');
  assert.equal(nodes.webdavConfirmTitle.textContent, '确认清除');
  assert.equal(nodes.webdavConfirmMessage.textContent, '确定要清除已保存的 WebDAV 密码吗？');
  assert.equal(nodes.webdavConfirmDescription.textContent, '清除后需要重新填写密码才能备份。');
  assert.equal(nodes.confirmWebdavDeleteBtn.textContent, '清除');
  assert.equal(sent.length, 0, '确认前不应发送清除请求');

  await nodes.confirmWebdavDeleteBtn._on.click();

  // 留空是「不修改」，清除必须走显式 null，否则后端会跳过写入。
  // 不用带内哨兵字符串：那会吞掉恰好等于哨兵值的合法密码
  assert.deepEqual(sent, [{ webdav_password: null }]);
  assert.equal(nodes.webdavClearPasswordBtn.style.display, 'none', '清除后入口应隐藏');
  assert.equal(nodes.webdavPassword.placeholder, '请输入密码');
});

test('backup saves the visible WebDAV target even when currentSettings already matches it', async () => {
  const source = readBackupSource();
  const defaultsSource = readFileSync(resolve('public/js/admin-settings-defaults.js'), 'utf8');

  const makeEl = () => ({
    value: '', textContent: '', innerHTML: '', placeholder: '', disabled: false,
    style: {}, classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (this._on ||= {})[type] = fn; },
    querySelectorAll: () => [], appendChild() {},
  });
  const nodes = {};
  const requests = [];
  const visibleUrl = 'https://new-dav.example.com/';

  const sandbox = {
    window: {
      showMessage() {},
      AdminSettings: {
        // 模拟主设置保存失败后，表单收集逻辑已提前改写内存对象的状态。
        currentSettings: {
          has_webdav_password: true,
          webdav_url: visibleUrl,
          webdav_username: 'user',
          webdav_dir: 'nav',
        },
      },
    },
    document: {
      getElementById: id => (nodes[id] ||= makeEl()),
      getElementsByName: () => [],
      querySelectorAll: () => [],
      body: { classList: { add() {}, remove() {} } },
    },
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      if (url === '/api/settings') {
        return new Response(JSON.stringify({ code: 200 }));
      }
      return new Response(JSON.stringify({
        code: 200,
        data: { filename: 'backup.json', siteCount: 1, categoryCount: 1 },
      }));
    },
    Response, Request, console,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(defaultsSource, sandbox, { filename: 'public/js/admin-settings-defaults.js' });
  vm.runInNewContext(source, sandbox, { filename: 'public/js/admin-settings-backup.js' });

  sandbox.window.AdminSettings.backup.getBackupRefs();
  nodes.webdavUrl.value = visibleUrl;
  nodes.webdavUsername.value = 'user';
  nodes.webdavDir.value = 'nav';

  await sandbox.window.AdminSettings.backup.runBackup();

  assert.deepEqual(requests.map(request => request.url), [
    '/api/settings',
    '/api/backup/webdav',
  ]);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    webdav_url: visibleUrl,
    webdav_username: 'user',
    webdav_dir: 'nav',
  });
});

test('unrelated settings refresh does not overwrite unsaved WebDAV inputs', () => {
  const defaultsSource = readFileSync(resolve('public/js/admin-settings-defaults.js'), 'utf8');
  const backupSource = readBackupSource();
  const formSource = readFileSync(resolve('public/js/admin-settings-form.js'), 'utf8');

  const makeEl = () => ({
    value: '', checked: false, textContent: '', innerHTML: '', placeholder: '',
    style: {}, children: [], parentElement: { style: {} },
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    querySelectorAll: () => [], appendChild() {},
  });
  const nodes = {};
  const sandbox = {
    window: {},
    document: {
      getElementById: id => (nodes[id] ||= makeEl()),
      getElementsByName: () => [],
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: makeEl,
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(defaultsSource, sandbox, { filename: 'public/js/admin-settings-defaults.js' });
  vm.runInNewContext(backupSource, sandbox, { filename: 'public/js/admin-settings-backup.js' });
  vm.runInNewContext(formSource, sandbox, { filename: 'public/js/admin-settings-form.js' });

  sandbox.window.AdminSettings.backup.getBackupRefs();
  Object.assign(sandbox.window.AdminSettings.currentSettings, {
    webdav_url: 'https://saved.example.com/',
    webdav_username: 'saved-user',
    webdav_dir: 'saved-dir',
    has_webdav_password: true,
  });
  nodes.webdavUrl.value = 'https://unsaved.example.com/';
  nodes.webdavUsername.value = 'unsaved-user';
  nodes.webdavDir.value = 'unsaved-dir';
  nodes.webdavPassword.value = 'new-password';

  // AI provider 变化等无关交互走无参数刷新，不能碰备份表单。
  sandbox.window.AdminSettings.form.updateUIFromSettings();
  assert.equal(nodes.webdavUrl.value, 'https://unsaved.example.com/');
  assert.equal(nodes.webdavUsername.value, 'unsaved-user');
  assert.equal(nodes.webdavDir.value, 'unsaved-dir');
  assert.equal(nodes.webdavPassword.value, 'new-password');

  // 只有服务端设置加载完成时才显式要求回填。
  sandbox.window.AdminSettings.form.updateUIFromSettings({ includeBackup: true });
  assert.equal(nodes.webdavUrl.value, 'https://saved.example.com/');
  assert.equal(nodes.webdavPassword.value, '');
});

test('main settings save marks the WebDAV password as configured when a new one is entered', () => {
  const defaultsSource = readFileSync(resolve('public/js/admin-settings-defaults.js'), 'utf8');
  const backupSource = readBackupSource();
  const formSource = readFileSync(resolve('public/js/admin-settings-form.js'), 'utf8');

  const makeEl = () => ({
    value: '', checked: false, textContent: '', innerHTML: '', placeholder: '',
    style: {}, children: [], parentElement: { style: {} },
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    querySelectorAll: () => [], appendChild() {},
  });
  const nodes = {};
  const sandbox = {
    window: {},
    document: {
      getElementById: id => (nodes[id] ||= makeEl()),
      getElementsByName: () => [],
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: makeEl,
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(defaultsSource, sandbox, { filename: 'public/js/admin-settings-defaults.js' });
  vm.runInNewContext(backupSource, sandbox, { filename: 'public/js/admin-settings-backup.js' });
  vm.runInNewContext(formSource, sandbox, { filename: 'public/js/admin-settings-form.js' });

  sandbox.window.AdminSettings.backup.getBackupRefs();
  sandbox.window.AdminSettings.currentSettings.has_webdav_password = false;
  nodes.webdavPassword.value = 'new-password';

  sandbox.window.AdminSettings.form.collectSettingsFromInputs();

  assert.equal(
    sandbox.window.AdminSettings.currentSettings.has_webdav_password,
    true,
    '主设置保存里填了新密码后，内存状态应立即反映已配置'
  );
  assert.equal(sandbox.window.AdminSettings.currentSettings.webdav_password, 'new-password');
});

test('settings tabs stay reachable on narrow touch screens', () => {
  const css = readFileSync(resolve('public/css/admin-card-preview.css'), 'utf8');
  const tabsRule = css.match(/\.settings-tabs\s*\{([^}]*)\}/)?.[1] || '';
  const buttonRule = css.match(/\.settings-tab-btn\s*\{([^}]*)\}/)?.[1] || '';
  const mobileRule = css.match(/@media \(max-width: 640px\)\s*\{\s*\.settings-tab-btn\s*\{([^}]*)\}/)?.[1] || '';

  assert.match(tabsRule, /overflow-x:\s*auto/);
  assert.match(tabsRule, /overscroll-behavior-inline:\s*contain/);
  assert.match(buttonRule, /flex:\s*0 0 auto/);
  assert.match(mobileRule, /min-height:\s*44px/);
});
