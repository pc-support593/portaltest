// 添付の文字の取り出しを、別スレッド(worker_threads)で行う(src/textExtract.js から起動される)。
// 重い・壊れた・悪意のあるファイルで、同期処理が長く続いても、メインのサーバー(全ユーザーのAPI)を止めないため。
// 呼び出し側が、時間切れで terminate() し、メモリの上限(resourceLimits)も付ける。
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { extractInline } = require('./textExtract');

extractInline(workerData.ext, Buffer.from(workerData.buf))
  .then(r => parentPort.postMessage(r))
  .catch(e => parentPort.postMessage({ status: 'failed', text: '', error: String((e && e.message) || e) }));
