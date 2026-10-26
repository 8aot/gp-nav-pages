// scripts/generate-test-data.js
// 生成 150 个分类和 2000 条书签的本地测试数据 SQL 脚本

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CATEGORY_COUNT = 150;
const SITE_COUNT = 2000;
const OUTPUT_FILE = path.resolve(__dirname, '../test-data.sql');

const TOP_LEVEL_DOMAINS = [
  '前端开发', '后端架构', '人工智能', '设计资源', 'DevOps & 运维',
  '数据库技术', '移动端开发', '开源社区', '产品运营', '效率工具',
  '音视频多媒体', '安全技术', '云原生', '测试与监控', '学习教程',
  '博客与资讯', '游戏开发', '硬件与物联网', '生活兴趣', '金融与经济'
];

const SECOND_LEVEL_SUBFIX = [
  '常用框架', '精品工具', '在线服务', '官方文档', '社区论坛',
  '开源库', '学习资源', '实践案例', '参考指南', '算法组件'
];

const SITE_PREFIXES = [
  '超级', '极速', '智享', '开源', '云端', '轻量', '未来', '智能', '开发者', '灵动'
];

const SITE_SUFFIXES = [
  '导航', '工具箱', '平台', '助手', '引擎', '社区', '手册', '工作流', '中心', 'Hub'
];

function escapeSql(str) {
  if (str === null || str === undefined) return 'NULL';
  return `'${String(str).replace(/'/g, "''")}'`;
}

function generateData() {
  const categories = [];
  
  // 1. 生成 150 个分类 (先分配顶级分类，再分配子分类)
  const topCount = TOP_LEVEL_DOMAINS.length; // 20 个顶级
  for (let i = 1; i <= topCount; i++) {
    categories.push({
      id: i,
      catelog: TOP_LEVEL_DOMAINS[i - 1],
      parent_id: 0,
      sort_order: i * 10,
      is_private: 0
    });
  }

  // 剩余 130 个分类挂在顶级分类下
  for (let i = topCount + 1; i <= CATEGORY_COUNT; i++) {
    const parentId = ((i - 1) % topCount) + 1;
    const parentName = categories[parentId - 1].catelog;
    const subfix = SECOND_LEVEL_SUBFIX[(i - 1) % SECOND_LEVEL_SUBFIX.length];
    const catelogName = `${parentName}-${subfix}-${Math.floor(i / topCount)}`;

    categories.push({
      id: i,
      catelog: catelogName,
      parent_id: parentId,
      sort_order: i * 10,
      is_private: i % 20 === 0 ? 1 : 0 // 少数私有
    });
  }

  // 2. 生成 2000 条书签
  const sites = [];
  for (let i = 1; i <= SITE_COUNT; i++) {
    const catIndex = (i - 1) % CATEGORY_COUNT;
    const cat = categories[catIndex];
    const prefix = SITE_PREFIXES[(i * 3) % SITE_PREFIXES.length];
    const suffix = SITE_SUFFIXES[(i * 7) % SITE_SUFFIXES.length];
    const name = `${prefix}${cat.catelog.slice(0, 4)}${suffix}_${i}`;
    const url = `https://nav-sample-${i}.example.com`;
    const logo = `https://api.iconify.design/lucide:globe.svg`;
    const desc = `用于 ${cat.catelog} 的优质书签工具，编号 #${i}`;
    const sort_order = i;
    const is_private = cat.is_private === 1 || (i % 25 === 0) ? 1 : 0;

    sites.push({
      id: i,
      name,
      url,
      logo,
      desc,
      catelog_id: cat.id,
      catelog_name: cat.catelog,
      sort_order,
      is_private
    });
  }

  // 3. 构造 SQL
  const lines = [];
  lines.push('-- 自动生成的本地测试数据 (150 分类, 2000 书签)');
  lines.push('PRAGMA foreign_keys = OFF;');
  lines.push('BEGIN TRANSACTION;');
  lines.push('');
  lines.push('-- 清理旧数据');
  lines.push('DELETE FROM category;');
  lines.push('DELETE FROM sites;');
  lines.push('');

  // 插入分类 (分批以防单条 SQL 过长)
  lines.push('-- 插入 150 个分类');
  const catBatchSize = 50;
  for (let i = 0; i < categories.length; i += catBatchSize) {
    const chunk = categories.slice(i, i + catBatchSize);
    lines.push('INSERT INTO category (id, catelog, parent_id, sort_order, is_private) VALUES');
    const values = chunk.map(c => 
      `(${c.id}, ${escapeSql(c.catelog)}, ${c.parent_id}, ${c.sort_order}, ${c.is_private})`
    ).join(',\n');
    lines.push(values + ';');
  }

  lines.push('');
  lines.push('-- 插入 2000 条书签');
  const siteBatchSize = 100;
  for (let i = 0; i < sites.length; i += siteBatchSize) {
    const chunk = sites.slice(i, i + siteBatchSize);
    lines.push('INSERT INTO sites (id, name, url, logo, desc, catelog_id, catelog_name, sort_order, is_private) VALUES');
    const values = chunk.map(s => 
      `(${s.id}, ${escapeSql(s.name)}, ${escapeSql(s.url)}, ${escapeSql(s.logo)}, ${escapeSql(s.desc)}, ${s.catelog_id}, ${escapeSql(s.catelog_name)}, ${s.sort_order}, ${s.is_private})`
    ).join(',\n');
    lines.push(values + ';');
  }

  lines.push('');
  lines.push('COMMIT;');
  lines.push('PRAGMA foreign_keys = ON;');

  fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf-8');
  console.log(`[成功] 测试数据已生成至: ${OUTPUT_FILE}`);
  console.log(`- 分类数: ${categories.length}`);
  console.log(`- 书签数: ${sites.length}`);
}

generateData();
