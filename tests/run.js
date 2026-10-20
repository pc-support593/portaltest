// 反映前の一括確認: node tests/run.js(または npm test)。1つでも失敗・エラーがあれば終了コード1
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const suites = ['unit.js', 'extract.js', 'jinjer.js', 'api.js', 'browser.js'];
const results = [];
for (const s of suites) {
  console.log(`\n===== ${s} =====`);
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  results.push([s, r.status === 0 ? 'OK  ' : r.status === 3 ? 'SKIP' : 'NG  ']);
}
console.log('\n===== 結果 =====');
for (const [s, st] of results) console.log(`${st}${s}`);
process.exit(results.every(([, st]) => st !== 'NG  ') ? 0 : 1);
