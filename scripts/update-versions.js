/**
 * 自动更新 CSS/JS 文件的版本号
 * 
 * 工作原理：
 * 1. 计算每个 CSS/JS 文件的内容 MD5 哈希
 * 2. 取哈希的前 8 位作为版本号
 * 3. 更新 HTML 文件中对应的 ?v=xxx 参数
 * 
 * 使用方式：
 * - 自动：通过 Git pre-commit hook 触发
 * - 手动：node scripts/update-versions.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 项目根目录
const ROOT_DIR = path.resolve(__dirname, '..');

// 需要处理的 HTML 文件及其资源映射
const HTML_FILES = {
  'public/index.html': [
    { file: 'public/css/style.css', pattern: /\/css\/style\.css\?v=[a-zA-Z0-9]+/ },
    { file: 'public/css/tailwind.min.css', pattern: /\/css\/tailwind\.min\.css\?v=[a-zA-Z0-9]+/ },
    { file: 'public/js/main.js', pattern: /\/js\/main\.js\?v=[a-zA-Z0-9]+/ },
    { file: 'public/favicon.svg', pattern: /\/favicon\.svg\?v=[a-zA-Z0-9]+/ },
  ],
  'public/admin/index.html': [
    { file: 'public/css/admin.css', pattern: /\/css\/admin\.css\?v=[a-zA-Z0-9]+/ },
    { file: 'public/css/admin-dropdown.css', pattern: /\/css\/admin-dropdown\.css\?v=[a-zA-Z0-9]+/ },
    { file: 'public/css/tailwind.min.css', pattern: /\/css\/tailwind\.min\.css\?v=[a-zA-Z0-9]+/ },
    { file: 'public/js/admin-cache.js', pattern: /\/js\/admin-cache\.js\?v=[a-zA-Z0-9]+/ },
    { file: 'public/js/admin.js', pattern: /\/js\/admin\.js\?v=[a-zA-Z0-9]+/ },
    { file: 'public/js/admin-categories.js', pattern: /\/js\/admin-categories\.js\?v=[a-zA-Z0-9]+/ },
    { file: 'public/js/admin-bookmarks.js', pattern: /\/js\/admin-bookmarks\.js\?v=[a-zA-Z0-9]+/ },
    { file: 'public/js/admin-batch.js', pattern: /\/js\/admin-batch\.js\?v=[a-zA-Z0-9]+/ },
    { file: 'public/js/admin-settings.js', pattern: /\/js\/admin-settings\.js\?v=[a-zA-Z0-9]+/ },
    { file: 'public/js/admin-import-export.js', pattern: /\/js\/admin-import-export\.js\?v=[a-zA-Z0-9]+/ },
    { file: 'public/favicon.svg', pattern: /\/favicon\.svg\?v=[a-zA-Z0-9]+/ },
  ]
};

/**
 * 计算文件内容的 MD5 哈希（取前 8 位）
 */
function getFileHash(filePath) {
  const fullPath = path.join(ROOT_DIR, filePath);
  
  if (!fs.existsSync(fullPath)) {
    console.warn(`  ⚠️  文件不存在: ${filePath}`);
    return null;
  }
  
  const content = fs.readFileSync(fullPath);
  return crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
}

/**
 * 从文件路径生成替换字符串
 * 例如: public/css/style.css -> /css/style.css?v=abc12345
 */
function buildReplacement(filePath, hash) {
  // 移除 public/ 前缀
  const urlPath = filePath.replace(/^public/, '');
  return `${urlPath}?v=${hash}`;
}

/**
 * 主函数
 */
function main() {
  console.log('📦 开始更新静态资源版本号...\n');
  
  let totalUpdated = 0;
  let htmlFilesModified = [];
  
  for (const [htmlFile, assets] of Object.entries(HTML_FILES)) {
    const htmlPath = path.join(ROOT_DIR, htmlFile);
    
    if (!fs.existsSync(htmlPath)) {
      console.warn(`⚠️  HTML 文件不存在: ${htmlFile}`);
      continue;
    }
    
    let html = fs.readFileSync(htmlPath, 'utf8');
    let modified = false;
    
    console.log(`📄 处理 ${htmlFile}:`);
    
    for (const asset of assets) {
      const hash = getFileHash(asset.file);
      
      if (!hash) continue;
      
      const replacement = buildReplacement(asset.file, hash);
      const oldMatch = html.match(asset.pattern);
      
      if (oldMatch) {
        const oldValue = oldMatch[0];
        
        if (oldValue !== replacement) {
          html = html.replace(asset.pattern, replacement);
          console.log(`   ✅ ${asset.file.replace('public/', '')} -> ?v=${hash}`);
          modified = true;
          totalUpdated++;
        } else {
          console.log(`   ⏭️  ${asset.file.replace('public/', '')} (未变化)`);
        }
      } else {
        console.log(`   ⚠️  未找到匹配: ${asset.pattern}`);
      }
    }
    
    if (modified) {
      fs.writeFileSync(htmlPath, html, 'utf8');
      htmlFilesModified.push(htmlFile);
    }
    
    console.log('');
  }
  
  // 输出汇总
  if (totalUpdated > 0) {
    console.log(`✨ 完成! 更新了 ${totalUpdated} 个资源版本号`);
    console.log(`📝 修改的文件: ${htmlFilesModified.join(', ')}`);
    return { updated: true, files: htmlFilesModified };
  } else {
    console.log('✨ 完成! 所有资源版本号均为最新，无需更新');
    return { updated: false, files: [] };
  }
}

// 执行
const result = main();

// 如果有更新，返回非零退出码以便 Git hook 知道需要重新暂存文件
// 但我们不返回错误码，而是让 hook 脚本处理
process.exit(0);
