/**
 * 查看某个 rollout 文件的类型直方图、事件顺序与每种 item 的样例。
 * 用法：node test/show-rollout.mjs <rollout 文件路径> [--max-samples N]
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node test/show-rollout.mjs <rollout 文件路径>');
  process.exit(2);
}
const maxSamples = Number(process.argv[4] ?? 20);
const KEY = (o) =>
  o.type === 'event_msg'
    ? `${o.type}/${o.payload?.type ?? '?'}${o.payload?.item ? ':' + o.payload.item.type : ''}`
    : `${o.type}/${o.payload?.type ?? '?'}`;

const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const objs = [];
for (const l of lines) { try { objs.push(JSON.parse(l)); } catch { /* ignore */ } }

console.log('文件:', file);
console.log('字节:', fs.statSync(file).size, '行数:', lines.length, '可解析:', objs.length);
const hist = new Map();
for (const o of objs) hist.set(KEY(o), (hist.get(KEY(o)) ?? 0) + 1);
console.log('直方图:', JSON.stringify([...hist].sort((a, b) => b[1] - a[1]), null, 0));
console.log('\nsession_meta:', JSON.stringify(objs.find((o) => o.type === 'session_meta')?.payload));
console.log('\n事件顺序（前 60 条）:');
for (const o of objs.slice(0, 60)) console.log('  ', KEY(o));

const seen = new Map();
for (const o of objs) {
  const k = o.type === 'event_msg' ? KEY(o) : o.type;
  if (!seen.has(k)) seen.set(k, o);
}
let n = 0;
for (const [k, sample] of seen) {
  if (n >= maxSamples) break;
  if (!k.startsWith('event_msg/') && k !== 'session_meta') continue;
  n += 1;
  console.log(`\n---- 模板 ${k} ----`);
  console.log(JSON.stringify(sample).slice(0, 1500));
}
