import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

function createFakeDom() {
  const allElements = [];

  function makeElement(tagName = 'div') {
    const element = {
      tagName,
      children: [],
      parentElement: null,
      className: '',
      style: {},
      value: '',
      textContent: '',
      listeners: {},
      _classes: new Set(),
      classList: null,
      appendChild(child) {
        child.parentElement = element;
        element.children.push(child);
        return child;
      },
      contains(node) {
        if (node === element) return true;
        return element.children.some(child => child.contains(node));
      },
      addEventListener(type, handler) {
        (element.listeners[type] ||= []).push(handler);
      },
      dispatchEvent(event) {
        (element.listeners[event.type] || []).forEach(handler => handler(event));
        return true;
      },
      click() {
        element.dispatchEvent({ type: 'click', target: element, stopPropagation() {} });
      },
    };

    // 模拟 innerHTML = '' 会移除子节点（createCascadingDropdown 依赖该行为重建下拉）
    let innerHTML = '';
    Object.defineProperty(element, 'innerHTML', {
      get: () => innerHTML,
      set: (value) => {
        innerHTML = value;
        if (value === '') {
          element.children.forEach(child => {
            child.parentElement = null;
            const index = allElements.indexOf(child);
            if (index >= 0) allElements.splice(index, 1);
          });
          element.children.length = 0;
        }
      },
    });

    element.classList = {
      add(name) { element._classes.add(name); },
      remove(name) { element._classes.delete(name); },
      contains(name) { return element._classes.has(name); },
      toggle(name) {
        if (element._classes.has(name)) element._classes.delete(name);
        else element._classes.add(name);
        return element._classes.has(name);
      },
    };

    allElements.push(element);
    return element;
  }

  function hasClass(element, name) {
    if (element._classes.has(name)) return true;
    return String(element.className || '').split(/\s+/).includes(name);
  }

  const nodes = {};
  const documentListeners = {};

  const document = {
    createElement: makeElement,
    getElementById: id => (nodes[id] ||= makeElement()),
    querySelectorAll(selector) {
      if (selector !== '.custom-dropdown-menu.show') return [];
      return allElements.filter(el => hasClass(el, 'custom-dropdown-menu') && hasClass(el, 'show'));
    },
    addEventListener(type, handler) {
      (documentListeners[type] ||= []).push(handler);
    },
  };

  return { document, nodes, documentListeners, makeElement };
}

function loadAdminShared() {
  const source = readFileSync(resolve('public/js/admin-shared.js'), 'utf8');
  const dom = createFakeDom();
  const sandbox = {
    document: dom.document,
    Event: class { constructor(type) { this.type = type; } },
    fetch: async () => ({ json: async () => ({}) }),
    console,
    setTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  vm.runInNewContext(source, sandbox, { filename: 'public/js/admin-shared.js' });
  return { sandbox, ...dom };
}

const categoriesTree = [{ id: 1, catelog: '工具', children: [] }];

test('重复创建下拉框只在 document 上注册一个 click 监听器', () => {
  const { sandbox, nodes, documentListeners } = loadAdminShared();

  for (let i = 0; i < 5; i += 1) {
    sandbox.createCascadingDropdown('addBookmarkCatelogWrapper', 'addBookmarkCatelog', categoriesTree);
    sandbox.createCascadingDropdown('editBookmarkCatelogWrapper', 'editBookmarkCatelog', categoriesTree);
  }

  assert.equal(documentListeners.click.length, 1, 'document click 监听器不应随弹窗打开次数累积');
  assert.ok(nodes.addBookmarkCatelogWrapper.children.length > 0);
});

test('外部点击关闭下拉，容器内点击保持展开', () => {
  const { sandbox, nodes, documentListeners, makeElement } = loadAdminShared();

  sandbox.createCascadingDropdown('addBookmarkCatelogWrapper', 'addBookmarkCatelog', categoriesTree);
  const wrapper = nodes.addBookmarkCatelogWrapper;
  const [trigger, menu] = wrapper.children;

  trigger.click();
  assert.equal(menu.classList.contains('show'), true, '点击 trigger 应展开菜单');

  const onDocumentClick = documentListeners.click[0];
  onDocumentClick({ target: trigger });
  assert.equal(menu.classList.contains('show'), true, '容器内点击不应关闭菜单');

  onDocumentClick({ target: makeElement() });
  assert.equal(menu.classList.contains('show'), false, '容器外点击应关闭菜单');
});

test('重建下拉框后残留监听器不会误关闭当前菜单', () => {
  const { sandbox, nodes, documentListeners } = loadAdminShared();

  sandbox.createCascadingDropdown('addBookmarkCatelogWrapper', 'addBookmarkCatelog', categoriesTree);
  sandbox.createCascadingDropdown('addBookmarkCatelogWrapper', 'addBookmarkCatelog', categoriesTree);

  const [trigger, menu] = nodes.addBookmarkCatelogWrapper.children;
  trigger.click();

  documentListeners.click.forEach(handler => handler({ target: trigger }));
  assert.equal(menu.classList.contains('show'), true);
});
