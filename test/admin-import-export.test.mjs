import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

test('closing import preview keeps scroll locked while another modal remains open', () => {
  const source = readFileSync(resolve('public/js/admin-import-export.js'), 'utf8');
  const bodyClasses = new Set();
  const nodes = {};
  const openModals = [];

  const makeElement = () => ({
    style: {},
    className: '',
    innerHTML: '',
    value: '',
    checked: false,
    files: [],
    addEventListener(type, handler) { (this._on ||= {})[type] = handler; },
    click() {},
  });

  const settingsModal = makeElement();
  settingsModal.className = 'modal settings-modal';
  settingsModal.style.display = 'block';
  openModals.push(settingsModal);

  const body = {
    classList: {
      add: name => bodyClasses.add(name),
      remove: name => bodyClasses.delete(name),
    },
    appendChild(element) { openModals.push(element); },
    removeChild(element) {
      const index = openModals.indexOf(element);
      if (index >= 0) openModals.splice(index, 1);
    },
  };

  const sandbox = {
    document: {
      body,
      createElement: makeElement,
      getElementById: id => (nodes[id] ||= makeElement()),
      querySelectorAll: selector => selector === '.modal' ? openModals : [],
      querySelector: () => null,
    },
    window: {},
    fetch: async () => new Response('{}'),
    Response,
    DOMParser: class {},
    FileReader: class {},
    FormData: class {},
    console,
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(source, sandbox, { filename: 'public/js/admin-import-export.js' });
  sandbox.showImportPreview({ category: [], sites: [] });

  assert.equal(bodyClasses.has('modal-open'), true);
  nodes.cancelImport.onclick();
  assert.equal(bodyClasses.has('modal-open'), true, '底层设置弹窗仍打开时应保留滚动锁');
});
