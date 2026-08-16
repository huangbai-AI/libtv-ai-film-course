import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKSPACE = '/Users/a1/Documents/Codex/2026-08-16/libtv-ai-sop-sop-1-2';
const REPO = path.join(WORKSPACE, 'work', 'libtv-ai-film-course');
const SYNCED_AT = new Date().toISOString();

const SOURCES = {
  sop: {
    title: 'LibTV × 罗永浩「AI 影视课」写稿与口播脚本 SOP',
    url: 'https://hcnbsg6ttb3t.feishu.cn/docx/RWqPdzqjnoeIKwx1HIKctPPwnqg',
    ref: 'RWqPdzqjnoeIKwx1HIKctPPwnqg',
    domain: 'https://hcnbsg6ttb3t.feishu.cn',
  },
  guide: {
    title: 'LibTV 使用指南',
    url: 'https://resonate.feishu.cn/wiki/Loxfw6XHziYRk0kKzdjcFfp9nhb',
    domain: 'https://resonate.feishu.cn',
  },
  course: {
    title: '课程合作｜罗老师 × LibTV（迭代中）',
    url: 'https://hcnbsg6ttb3t.feishu.cn/wiki/CBzBwlxGoiR0iFkYYaCcwskVnac',
    domain: 'https://hcnbsg6ttb3t.feishu.cn',
  },
};

const manifest = {
  synced_at: SYNCED_AT,
  documents: [],
  linked_documents: [],
  embedded_bases: [],
  errors: [],
};

const knownTokens = new Set();
const pendingCites = [];
const embeddedBases = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, value, 'utf8');
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(args, options = {}) {
  return execFileSync(args[0], args.slice(1), {
    cwd: options.cwd || WORKSPACE,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runJson(args, options = {}) {
  const stdout = run(args, options).trim();
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error(`没有获得 JSON：${args.join(' ')}`);
  return JSON.parse(stdout.slice(first, last + 1));
}

function safeName(value, fallback = 'untitled') {
  const result = String(value || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100);
  return result || fallback;
}

function relFromDoc(docDir, absoluteFile) {
  const rel = path.relative(docDir, absoluteFile).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function attrs(tag) {
  const result = {};
  for (const match of tag.matchAll(/([:\w-]+)="([^"]*)"/g)) result[match[1]] = match[2];
  return result;
}

function tagsOf(content, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, 'g');
  return [...content.matchAll(pattern)].map((match) => match[0]);
}

function fetchDocument(ref, markdown = true) {
  const args = ['lark-cli', 'docs', '+fetch', '--as', 'user', '--doc', ref, '--detail', markdown ? 'simple' : 'full'];
  if (markdown) args.push('--doc-format', 'markdown');
  return runJson(args).data.document;
}

function nodeGet(urlOrToken) {
  return runJson(['lark-cli', 'wiki', '+node-get', '--as', 'user', '--node-token', urlOrToken, '--format', 'json']).data;
}

function nodeChildren(spaceId, nodeToken) {
  const result = runJson([
    'lark-cli', 'wiki', '+node-list', '--as', 'user', '--space-id', String(spaceId),
    '--parent-node-token', nodeToken, '--page-all', '--page-limit', '0', '--format', 'json',
  ]);
  return result.data.nodes || [];
}

function collectResources(markdown, xml) {
  const resources = new Map();
  const add = (token, type, meta = {}) => {
    if (!token || /^https?:/i.test(token)) return;
    const key = `${type}:${token}`;
    if (!resources.has(key)) resources.set(key, { token, type, ...meta });
  };

  for (const match of markdown.matchAll(/https:\/\/feishu\.cn\/file\/([A-Za-z0-9]+)/g)) add(match[1], 'media');
  for (const tag of tagsOf(xml, 'img')) {
    const a = attrs(tag);
    add(a.token || a.src, 'media', { name: a.name, alt: a.alt, mime: a.mime });
  }
  for (const tag of tagsOf(xml, 'source')) {
    const a = attrs(tag);
    add(a.token || a.src, 'media', { name: a.name, mime: a.mime });
  }
  for (const tag of tagsOf(xml, 'whiteboard')) {
    const a = attrs(tag);
    add(a.token, 'whiteboard', { name: '飞书画板' });
  }
  return [...resources.values()];
}

function downloadResources(resources, docDir) {
  const assetDir = path.join(docDir, 'assets');
  ensureDir(assetDir);
  const downloaded = [];
  for (let i = 0; i < resources.length; i += 1) {
    const resource = resources[i];
    const outputBase = path.join(assetDir, resource.token);
    const relativeOutput = path.relative(WORKSPACE, outputBase);
    const args = ['lark-cli', 'docs', '+media-download', '--as', 'user'];
    if (resource.type === 'whiteboard') args.push('--type', 'whiteboard');
    args.push('--token', resource.token, '--output', relativeOutput);
    try {
      const result = runJson(args);
      const saved = result.data.saved_path;
      downloaded.push({ ...resource, ok: true, saved_path: saved, link: relFromDoc(docDir, saved), size_bytes: result.data.size_bytes });
    } catch (error) {
      downloaded.push({ ...resource, ok: false, error: String(error.message || error) });
    }
    if ((i + 1) % 20 === 0 || i + 1 === resources.length) {
      console.log(`    素材 ${i + 1}/${resources.length}`);
    }
  }
  return downloaded;
}

function makeGithubMarkdown(markdown, xml, downloads, domain) {
  let result = markdown;
  const byToken = new Map(downloads.filter((item) => item.ok).map((item) => [item.token, item]));

  result = result.replace(/<title>([\s\S]*?)<\/title>/g, '# $1');
  result = result.replace(/<callout\b[^>]*>/g, '\n> **提示**\n>');
  result = result.replace(/<\/callout>/g, '\n');
  result = result.replace(/<\/?(?:grid|column|figure)\b[^>]*>/g, '\n');
  result = result.replace(/<readonly-block\b[^>]*><\/readonly-block>/g, '> 飞书内嵌内容，请在来源文档中查看。');

  result = result.replace(/<cite\b([^>]*)><\/cite>/g, (whole, body) => {
    const a = attrs(`<cite ${body}>`);
    if (a['doc-id']) return `[${a.title || '关联飞书文档'}](${domain}/wiki/${a['doc-id']})`;
    return a.title || '飞书引用';
  });

  result = result.replace(/!\[([^\]]*)\]\(https:\/\/feishu\.cn\/file\/([A-Za-z0-9]+)\)/g, (whole, alt, token) => {
    const item = byToken.get(token);
    return item ? `![${alt}](${item.link})` : whole;
  });

  result = result.replace(/<img\b[^>]*(?:src|token)="([A-Za-z0-9]+)"[^>]*\/?\s*>/g, (whole, token) => {
    const item = byToken.get(token);
    const a = attrs(whole);
    return item ? `![${a.alt || a.name || '图片'}](${item.link})` : whole;
  });

  result = result.replace(/<source\b[^>]*token="([A-Za-z0-9]+)"[^>]*\/?\s*>/g, (whole, token) => {
    const item = byToken.get(token);
    const a = attrs(whole);
    return item ? `[附件：${a.name || token}](${item.link})` : whole;
  });

  result = result.replace(/<whiteboard\b[^>]*token="([A-Za-z0-9]+)"[^>]*><\/whiteboard>/g, (whole, token) => {
    const item = byToken.get(token);
    return item ? `![飞书画板](${item.link})` : whole;
  });

  result = result.replace(/<bitable\b([^>]*)><\/bitable>/g, (whole, body) => {
    const a = attrs(`<bitable ${body}>`);
    return `> 嵌入多维表格：${a.token || ''} / ${a['table-id'] || ''}。完整导出见仓库的 \`data/bases\` 目录。`;
  });

  const successful = downloads.filter((item) => item.ok);
  const failed = downloads.filter((item) => !item.ok);
  if (successful.length || failed.length) {
    result += '\n\n## 本地素材清单\n\n';
    for (const item of successful) result += `- [${item.name || item.token}](${item.link})（${item.type}，${item.size_bytes || 0} 字节）\n`;
    for (const item of failed) result += `- 下载失败：${item.name || item.token}（${item.token}）\n`;
  }
  return `${result.trim()}\n`;
}

function collectEmbeds(xml, sourceMeta) {
  for (const tag of tagsOf(xml, 'bitable')) {
    const a = attrs(tag);
    if (a.token) embeddedBases.set(a.token, { base_token: a.token, table_id: a['table-id'] || '', source: sourceMeta });
  }

  for (const match of xml.matchAll(/<cite\b[^>]*\bfile-type="wiki"[^>]*\bdoc-id="([A-Za-z0-9]+)"[^>]*>/g)) {
    pendingCites.push({ token: match[1], domain: sourceMeta.domain, from: sourceMeta.source_url });
  }
  for (const match of xml.matchAll(/<cite\b[^>]*\bdoc-id="([A-Za-z0-9]+)"[^>]*\bfile-type="wiki"[^>]*>/g)) {
    pendingCites.push({ token: match[1], domain: sourceMeta.domain, from: sourceMeta.source_url });
  }
}

function exportDoc({ ref, title, sourceUrl, domain, dir, node = null, category = 'primary' }) {
  console.log(`  导出：${title}`);
  ensureDir(dir);
  try {
    const mdDoc = fetchDocument(ref, true);
    const xmlDoc = fetchDocument(ref, false);
    const resources = collectResources(mdDoc.content || '', xmlDoc.content || '');
    const downloads = downloadResources(resources, dir);
    const meta = {
      title,
      source_url: sourceUrl,
      domain,
      node_token: node?.node_token || '',
      obj_token: node?.obj_token || mdDoc.document_id || '',
      obj_type: node?.obj_type || 'docx',
      revision_id: mdDoc.revision_id,
      synced_at: SYNCED_AT,
      resource_count: resources.length,
      resource_downloaded: downloads.filter((item) => item.ok).length,
    };
    const header = `> 来源：[飞书原文](${sourceUrl})  \n> 同步时间：${SYNCED_AT}  \n> 文档标识：${meta.obj_token || meta.node_token}\n\n`;
    writeText(path.join(dir, 'README.md'), header + makeGithubMarkdown(mdDoc.content || '', xmlDoc.content || '', downloads, domain));
    writeText(path.join(dir, 'source.xml'), `${xmlDoc.content || ''}\n`);
    writeJson(path.join(dir, 'source.json'), meta);
    writeJson(path.join(dir, 'assets', 'index.json'), downloads);
    collectEmbeds(xmlDoc.content || '', meta);
    knownTokens.add(meta.node_token);
    knownTokens.add(meta.obj_token);
    const entry = { ...meta, repo_path: path.relative(REPO, dir).split(path.sep).join('/') };
    if (category === 'linked') manifest.linked_documents.push(entry);
    else manifest.documents.push(entry);
    return entry;
  } catch (error) {
    const item = { title, source_url: sourceUrl, error: String(error.message || error) };
    manifest.errors.push(item);
    writeText(path.join(dir, 'README.md'), `# ${title}\n\n导出失败：${item.error}\n\n来源：${sourceUrl}\n`);
    console.log(`    失败：${item.error}`);
    return null;
  }
}

function exportNodeTree(node, domain, dir, depth = 0) {
  if (depth > 10) throw new Error('知识库层级超过 10 层，已停止');
  const sourceUrl = `${domain}/wiki/${node.node_token}`;
  exportDoc({ ref: node.obj_token || sourceUrl, title: node.title, sourceUrl, domain, dir, node });
  if (!node.has_child) return;
  const children = nodeChildren(node.space_id, node.node_token);
  children.forEach((child, index) => {
    const childDir = path.join(dir, `${String(index + 1).padStart(2, '0')}-${safeName(child.title)}`);
    exportNodeTree(child, domain, childDir, depth + 1);
  });
}

function listAll(baseToken, command, extraArgs, itemKey, limit) {
  const items = [];
  let offset = 0;
  for (;;) {
    const result = runJson(['lark-cli', 'base', command, '--as', 'user', '--base-token', baseToken, ...extraArgs, '--limit', String(limit), '--offset', String(offset), '--format', 'json']);
    const page = result.data?.[itemKey] || [];
    items.push(...page);
    const total = Number(result.data?.total ?? items.length);
    if (!page.length || items.length >= total) break;
    offset += page.length;
  }
  return items;
}

function fetchAllRecords(baseToken, tableId, limit = 200) {
  const rows = [];
  const recordIds = [];
  let schema = {};
  let offset = 0;
  for (;;) {
    const result = runJson([
      'lark-cli', 'base', '+record-list', '--as', 'user', '--base-token', baseToken,
      '--table-id', tableId, '--limit', String(limit), '--offset', String(offset), '--format', 'json',
    ]);
    const data = result.data || {};
    const page = Array.isArray(data.data) ? data.data : [];
    rows.push(...page);
    recordIds.push(...(Array.isArray(data.record_id_list) ? data.record_id_list : []));
    if (!schema.fields) {
      schema = {
        fields: data.fields || [],
        field_id_list: data.field_id_list || [],
        field_type_list: data.field_type_list || [],
      };
    }
    if (!data.has_more || page.length === 0) break;
    offset += page.length;
  }
  return { ...schema, rows, record_id_list: recordIds, total: rows.length };
}

function markdownCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function recordsToMarkdown(table, records) {
  const headers = records.fields || [];
  const rows = records.rows || [];
  let result = `# ${table.name || table.id}\n\n记录数：${rows.length}\n\n`;
  if (!headers.length) return `${result}> 暂无可读取字段。\n`;
  result += `| 记录标识 | ${headers.map(markdownCell).join(' | ')} |\n`;
  result += `| --- | ${headers.map(() => '---').join(' | ')} |\n`;
  rows.forEach((row, index) => {
    result += `| ${markdownCell(records.record_id_list?.[index] || '')} | ${(row || []).map(markdownCell).join(' | ')} |\n`;
  });
  return result;
}

function exportBase(embed, index) {
  const baseToken = embed.base_token;
  const baseDir = path.join(REPO, 'data', 'bases', `${String(index + 1).padStart(2, '0')}-${safeName(baseToken)}`);
  ensureDir(baseDir);
  console.log(`  导出多维表格：${baseToken}`);
  try {
    const base = runJson(['lark-cli', 'base', '+base-get', '--as', 'user', '--base-token', baseToken, '--format', 'json']);
    const tables = listAll(baseToken, '+table-list', [], 'tables', 100);
    writeJson(path.join(baseDir, 'base.json'), base);
    writeJson(path.join(baseDir, 'tables.json'), tables);
    for (const table of tables) {
      const tableDir = path.join(baseDir, safeName(`${table.id}-${table.name || 'table'}`));
      ensureDir(tableDir);
      const fields = listAll(baseToken, '+field-list', ['--table-id', table.id], 'fields', 200);
      const records = fetchAllRecords(baseToken, table.id, 200);
      writeJson(path.join(tableDir, 'fields.json'), fields);
      writeJson(path.join(tableDir, 'records.json'), records);
      writeText(path.join(tableDir, 'records.md'), recordsToMarkdown(table, records));
    }
    const item = { base_token: baseToken, table_id: embed.table_id, source: embed.source, repo_path: path.relative(REPO, baseDir).split(path.sep).join('/'), table_count: tables.length };
    manifest.embedded_bases.push(item);
  } catch (error) {
    const item = { base_token: baseToken, error: String(error.message || error) };
    manifest.errors.push(item);
    writeJson(path.join(baseDir, 'error.json'), item);
  }
}

function treeLines(rootDir) {
  const lines = [];
  function walk(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !['assets'].includes(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    entries.forEach((entry, index) => {
      const isLast = index === entries.length - 1;
      lines.push(`${prefix}${isLast ? '└── ' : '├── '}${entry.name}`);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${isLast ? '    ' : '│   '}`);
    });
  }
  lines.push(path.basename(rootDir));
  walk(rootDir);
  return lines.join('\n');
}

function createIndexes() {
  const docCount = manifest.documents.length + manifest.linked_documents.length;
  const assetCount = [...manifest.documents, ...manifest.linked_documents].reduce((sum, item) => sum + Number(item.resource_downloaded || 0), 0);
  const readme = `# LibTV × 罗永浩 AI 影视课资料库\n\n本仓库用于私有同步和管理课程 SOP、LibTV 使用指南、合作脚本主文档与子文档。\n\n## 内容入口\n\n- [写稿与口播脚本 SOP](docs/01-sop/README.md)\n- [LibTV 使用指南](docs/02-libtv-guide/README.md)\n- [课程合作主文档与全部子文档](docs/03-course-collaboration/README.md)\n- [关联飞书文档](docs/04-linked-references/)\n- [嵌入多维表格数据](data/bases/)\n- [来源与同步说明](sync/SOURCES.md)\n\n## 本次同步\n\n- 文档：${docCount} 份\n- 已下载素材：${assetCount} 个\n- 嵌入多维表格：${manifest.embedded_bases.length} 个\n- 同步时间：${SYNCED_AT}\n\n> 本仓库包含合作脚本和内部资料，请保持私有，不要对外传播。\n`;
  writeText(path.join(REPO, 'README.md'), readme);
  writeText(path.join(REPO, '.gitignore'), '.DS_Store\n*.tmp\n');
  writeJson(path.join(REPO, 'sync', 'manifest.json'), manifest);
  const sources = `# 来源与同步说明\n\n- SOP：${SOURCES.sop.url}\n- LibTV 使用指南：${SOURCES.guide.url}\n- 课程合作总文档：${SOURCES.course.url}\n- 同步时间：${SYNCED_AT}\n\n## 说明\n\n- 知识库按原目录递归导出。\n- 每份文档包含 GitHub 可读版 \`README.md\`、飞书原始结构 \`source.xml\` 和元数据 \`source.json\`。\n- 图片、音视频附件和画板缩略图保存在各文档的 \`assets\` 目录。\n- 嵌入多维表格以字段和记录 JSON 形式保存在 \`data/bases\`。\n`;
  writeText(path.join(REPO, 'sync', 'SOURCES.md'), sources);
  writeText(path.join(REPO, 'sync', 'TREE.md'), `# 仓库目录\n\n\`\`\`text\n${treeLines(REPO)}\n\`\`\`\n`);
  const scriptPath = fileURLToPath(import.meta.url);
  writeText(path.join(REPO, 'scripts', 'sync-feishu.mjs'), fs.readFileSync(scriptPath, 'utf8'));
}

function main() {
  if (fs.existsSync(REPO)) throw new Error(`目标目录已存在，为避免覆盖已停止：${REPO}`);
  ensureDir(REPO);
  console.log('开始导出飞书资料');

  exportDoc({
    ref: SOURCES.sop.ref,
    title: SOURCES.sop.title,
    sourceUrl: SOURCES.sop.url,
    domain: SOURCES.sop.domain,
    dir: path.join(REPO, 'docs', '01-sop'),
  });

  const guideRoot = nodeGet(SOURCES.guide.url);
  exportNodeTree(guideRoot, SOURCES.guide.domain, path.join(REPO, 'docs', '02-libtv-guide'));

  const courseRoot = nodeGet(SOURCES.course.url);
  exportNodeTree(courseRoot, SOURCES.course.domain, path.join(REPO, 'docs', '03-course-collaboration'));

  let linkedIndex = 0;
  const seenCites = new Set();
  while (pendingCites.length && linkedIndex < 50) {
    const cite = pendingCites.shift();
    if (!cite?.token || seenCites.has(cite.token) || knownTokens.has(cite.token)) continue;
    seenCites.add(cite.token);
    try {
      const url = `${cite.domain}/wiki/${cite.token}`;
      const node = nodeGet(url);
      if (knownTokens.has(node.node_token) || knownTokens.has(node.obj_token) || node.obj_type !== 'docx') continue;
      linkedIndex += 1;
      const dir = path.join(REPO, 'docs', '04-linked-references', `${String(linkedIndex).padStart(2, '0')}-${safeName(node.title)}`);
      exportDoc({ ref: node.obj_token, title: node.title, sourceUrl: url, domain: cite.domain, dir, node, category: 'linked' });
    } catch (error) {
      manifest.errors.push({ linked_token: cite.token, from: cite.from, error: String(error.message || error) });
    }
  }

  [...embeddedBases.values()].forEach((embed, index) => exportBase(embed, index));
  createIndexes();
  console.log(`导出完成：${manifest.documents.length + manifest.linked_documents.length} 份文档，${manifest.embedded_bases.length} 个多维表格`);
  console.log(REPO);
}

if (process.argv.includes('--repair-base')) {
  exportBase({
    base_token: 'LJmCb7DQZamyfesHwgNc5wiTnpd',
    table_id: 'tblu1tDgEhqFTtfT',
    source: { source_url: SOURCES.course.url },
  }, 0);
  writeText(path.join(REPO, 'scripts', 'sync-feishu.mjs'), fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  console.log('多维表格记录和同步脚本已修复');
} else {
  main();
}
