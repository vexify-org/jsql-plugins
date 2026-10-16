#!/usr/bin/env node
/**
 * security-scan.js - Scan PR diff or local files for dangerous patterns
 * 
 * Usage:
 *   node security-scan.js                     # scan all plugins/*.js (legacy)
 *   node security-scan.js --diff <file>       # scan a PR diff file
 *   node security-scan.js --file <path>       # scan a single file
 *   node security-scan.js --stdin             # scan from stdin
 * 
 * Output: JSON to stdout, {verdict, reason, files}
 */

const fs = require('fs');
const path = require('path');

const DANGEROUS_PATTERNS = [
  { pattern: 'child_process.exec', severity: 'critical', reason: '远程命令执行' },
  { pattern: 'child_process.spawn', severity: 'critical', reason: '子进程创建' },
  { pattern: 'eval(', severity: 'critical', reason: '动态代码执行' },
  { pattern: 'new Function(', severity: 'critical', reason: '动态函数构造' },
  { pattern: 'process.exit', severity: 'high', reason: '进程退出' },
  { pattern: 'process.kill', severity: 'critical', reason: '进程终止' },
  { pattern: 'fs.writeFileSync', severity: 'critical', reason: '任意文件写入' },
  { pattern: 'fs.unlinkSync', severity: 'critical', reason: '任意文件删除' },
  { pattern: 'fs.rmSync', severity: 'critical', reason: '任意文件删除' },
  { pattern: 'rm -rf', severity: 'critical', reason: '递归强制删除' },
  { pattern: 'wget(', severity: 'critical', reason: '远程文件下载执行' },
  { pattern: 'curl(', severity: 'high', reason: '远程请求' },
  { pattern: 'exec(', severity: 'critical', reason: '命令执行' },
  { pattern: 'setTimeout(() => require', severity: 'critical', reason: '动态模块加载' },
  { pattern: '__dirname', severity: 'low', reason: '路径泄露' },
  { pattern: '__filename', severity: 'low', reason: '文件名泄露' },
  { pattern: 'require("fs")', severity: 'medium', reason: '文件系统访问' },
  { pattern: 'require("child_process")', severity: 'critical', reason: '子进程访问' },
  { pattern: 'require("http")', severity: 'medium', reason: '网络请求模块' },
  { pattern: 'Buffer.from', severity: 'low', reason: '缓冲区操作' },
];

const SAFE_PATTERNS = [
  '// safe:', '# safe:', '/* safe */',
  '# nosec', '// nosec', 'eslint-disable',
];

// Parse diff format, extract file contents
function extractFilesFromDiff(diffContent) {
  const files = {};
  let currentFile = null;
  let currentContent = [];
  let inHunk = false;
  
  const lines = diffContent.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        files[currentFile] = currentContent.join('\n');
      }
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      currentFile = match ? match[2] : null;
      currentContent = [];
      inHunk = false;
    } else if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
      // skip the a/ and b/ lines, file already set
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (currentFile && inHunk) {
      // Only include added lines (prefixed with +)
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentContent.push(line.slice(1));
      }
    }
  }
  if (currentFile) {
    files[currentFile] = currentContent.join('\n');
  }
  return files;
}

// Scan content for dangerous patterns
function scanContent(content, filePath) {
  const findings = [];
  const ext = path.extname(filePath).toLowerCase();
  
  // Only scan code files
  if (!['.js', '.ts', '.mjs', '.cjs', '.sh', '.bash'].includes(ext)) {
    return findings;
  }
  
  for (const item of DANGEROUS_PATTERNS) {
    if (content.includes(item.pattern)) {
      // Check if it's in a safe comment
      const idx = content.indexOf(item.pattern);
      const before = content.slice(Math.max(0, idx - 50), idx);
      const after = content.slice(idx + item.pattern.length, idx + item.pattern.length + 20);
      
      let isSafe = false;
      for (const safe of SAFE_PATTERNS) {
        if (before.includes(safe) || after.includes(safe)) {
          isSafe = true;
          break;
        }
      }
      
      if (!isSafe) {
        findings.push({ pattern: item.pattern, severity: item.severity, reason: item.reason });
      }
    }
  }
  return findings;
}

// Legacy mode: scan all plugins
function scanAllPlugins() {
  const pluginsDir = path.join(__dirname, '../plugins');
  const dirs = fs.readdirSync(pluginsDir).filter(d => d !== '_template');
  const results = [];
  
  for (const dir of dirs) {
    const indexPath = path.join(pluginsDir, dir, 'index.js');
    if (!fs.existsSync(indexPath)) continue;
    
    const content = fs.readFileSync(indexPath, 'utf8');
    const findings = scanContent(content, `plugins/${dir}/index.js`);
    
    if (findings.length > 0) {
      for (const f of findings) {
        console.error(`🚨 SECURITY: Found "${f.pattern}" in ${dir}/index.js (${f.reason})`);
      }
    } else {
      console.log(`✅ ${dir} passed security check`);
    }
    results.push({ file: `${dir}/index.js`, findings });
  }
  
  const hasDangerous = results.some(r => r.findings.length > 0);
  if (hasDangerous) process.exit(1);
  console.log('All plugins passed security check');
  return { verdict: 'safe', reason: 'all clear', results };
}

// PR diff scan mode
function scanDiff(diffFile) {
  if (!fs.existsSync(diffFile)) {
    console.error(`Diff file not found: ${diffFile}`);
    process.exit(2);
  }
  
  const diffContent = fs.readFileSync(diffFile, 'utf8');
  if (!diffContent.trim()) {
    return { verdict: 'safe', reason: 'empty diff', files: [] };
  }
  
  const files = extractFilesFromDiff(diffContent);
  const allFindings = {};
  let hasDangerous = false;
  
  for (const [filePath, content] of Object.entries(files)) {
    const findings = scanContent(content, filePath);
    if (findings.length > 0) {
      hasDangerous = true;
      allFindings[filePath] = findings;
      // Log to stderr for visibility
      for (const f of findings) {
        console.error(`🚨 SECURITY: Found "${f.pattern}" in ${filePath} (${f.reason})`);
      }
    } else {
      console.log(`✅ ${filePath} passed security check`);
    }
  }
  
  const result = {
    verdict: hasDangerous ? 'unsafe' : 'safe',
    reason: hasDangerous ? `Found dangerous patterns: ${Object.keys(allFindings).join(', ')}` : 'all clear',
    files: Object.keys(files),
    findings: allFindings,
  };
  
  console.log(JSON.stringify(result));
  return result;
}

// CLI
const args = process.argv.slice(2);
if (args.includes('--diff')) {
  const idx = args.indexOf('--diff');
  const result = scanDiff(args[idx + 1] || '/tmp/pr.diff');
  if (result.verdict === 'unsafe') process.exit(1);
} else if (args.includes('--file')) {
  const idx = args.indexOf('--file');
  const content = fs.readFileSync(args[idx + 1], 'utf8');
  const findings = scanContent(content, args[idx + 1]);
  const result = { verdict: findings.length > 0 ? 'unsafe' : 'safe', findings, file: args[idx + 1] };
  console.log(JSON.stringify(result));
  if (findings.length > 0) process.exit(1);
} else if (args.includes('--stdin')) {
  const content = fs.readFileSync('/dev/stdin', 'utf8');
  const findings = scanContent(content, 'stdin');
  const result = { verdict: findings.length > 0 ? 'unsafe' : 'safe', findings };
  console.log(JSON.stringify(result));
  if (findings.length > 0) process.exit(1);
} else {
  // Legacy mode
  scanAllPlugins();
}
