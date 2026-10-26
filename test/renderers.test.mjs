import test from 'node:test';
import assert from 'node:assert/strict';

import { renderSiteCards } from '../functions/lib/card-renderer.js';
import { renderHorizontalMenu, renderVerticalMenu } from '../functions/lib/menu-renderer.js';
import { parseSettings } from '../functions/lib/settings-parser.js';

test('renderSiteCards escapes user-controlled fields and rejects unsafe URLs', () => {
  const html = renderSiteCards([
    {
      id: 7,
      name: '<script>alert(1)</script>',
      url: 'javascript:alert(1)',
      logo: 'data:text/html,<svg>',
      desc: '"quoted" & <b>bold</b>',
      catelog_name: '<Work>',
    },
  ], parseSettings([]));

  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(html, /&lt;Work&gt;/);
  assert.match(html, /href="#"/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.doesNotMatch(html, /data:text\/html/);
});

test('renderSiteCards reflects layout options used by SSR cards', () => {
  const settings = parseSettings([
    { key: 'layout_hide_desc', value: 'true' },
    { key: 'layout_hide_links', value: 'true' },
    { key: 'layout_hide_category', value: 'true' },
    { key: 'layout_enable_frosted_glass', value: 'true' },
    { key: 'layout_card_style', value: 'style2' },
  ]);

  const html = renderSiteCards([
    { id: 1, name: 'Example', url: 'https://example.com', desc: 'Hidden', catelog_name: 'Hidden' },
  ], settings);

  assert.match(html, /frosted-glass-effect/);
  assert.match(html, /style-2/);
  assert.doesNotMatch(html, /Hidden/);
  assert.doesNotMatch(html, /copy-btn/);
});

test('menu renderers escape names and encode category URLs', () => {
  const categories = [
    {
      id: 1,
      catelog: 'A & B',
      children: [
        { id: 2, catelog: '<Child>', children: [] },
      ],
    },
  ];

  const horizontal = renderHorizontalMenu(categories, '<Child>');
  const vertical = renderVerticalMenu(categories, 'A & B', false);

  assert.match(horizontal, /A &amp; B/);
  assert.match(horizontal, /%3CChild%3E/);
  assert.match(horizontal, /&lt;Child&gt;/);
  assert.match(horizontal, /data-id="2"/);
  assert.match(vertical, /A &amp; B/);
  assert.match(vertical, /nav|bg-secondary-100|text-primary-700/);
});
