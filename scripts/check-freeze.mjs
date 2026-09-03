// check-freeze.mjs — 历史文件名保留；实际职责是投放状态提醒(DISTRIBUTION.md 的执行臂)。
//
// 设计取舍(重要):这个脚本**故意不阻断构建**。能被 --no-verify / --skip 绕过的技术阻断,
// 只会训练你学会绕过——绕过一次,纪律就永久失效了。它做的是唯一对一人团队真正有效的事:
// 每次构建都把「距离你自己承诺投放优先,已经过去多少天」戳到你脸上,并且这个数字只会变大。
//
// 用法:node scripts/check-freeze.mjs    (已挂到 app 的 prebuild;投放后自动静默)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(REPO, 'DISTRIBUTION.md');

let txt = '';
try { txt = fs.readFileSync(FILE, 'utf8'); } catch { process.exit(0); }   // 文件没了就不烦人

const field = (k) => (txt.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) || [, ''])[1].trim();
const status = field('STATUS');
if (status === 'distributed') {
  const at = field('DISTRIBUTED_AT') || '?';
  console.log(`  ✓ 已投放(${at})${field('PUBLIC_URL') ? ' · ' + field('PUBLIC_URL') : ''} — 投放提醒解除`);
  process.exit(0);
}

// 未投放:算天数 + 数门禁
const pledge = field('PLEDGE_DATE');
const days = pledge ? Math.floor((Date.now() - Date.parse(pledge + 'T00:00:00Z')) / 86400000) : null;
const gates = [...txt.matchAll(/^- \[([ xX])\] \*\*(G\d)/gm)];
const done = gates.filter((m) => m[1].toLowerCase() === 'x').length;
const openGates = gates.filter((m) => m[1] === ' ').map((m) => m[2]);
const ship = [...txt.matchAll(/^- \[([ xX])\] \*\*(D\d)/gm)];
const shipDone = ship.filter((m) => m[1].toLowerCase() === 'x').length;

const R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';
console.log(`
${R}${B}╔══════════════════════════════════════════════════════════════════╗
║  ⚠  投放尚未完成 —— STATUS: not_distributed                      ║
╚══════════════════════════════════════════════════════════════════╝${X}
  ${B}距离最初写下投放承诺,已经 ${days == null ? '?' : days} 天。${X}
  投放门禁:${done}/${gates.length} 绿${openGates.length ? `  ${Y}未完成:${openGates.join(' ')}${X}` : `  ${Y}(全绿 → 可以投放了)${X}`}
  投放三件套:${shipDone}/${ship.length}
${D}
  双旗舰纪律:产品工作可并行,但功能永远不是投放的前置条件。
  投放卡在创始人动作(密钥/部署/发帖),不卡在盖功能——别用「再做完 X 再投放」拖延。
  详情:DISTRIBUTION.md   ·   本闸不阻断构建,只让「投放还没做」始终可见。
${X}`);
process.exit(0);
