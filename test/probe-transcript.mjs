/**
 * 用 codex 自己的 app-server 问它：这个线程的「会话历史」里到底有什么？
 * 这正是 CLI/TUI 渲染转录用的那条通道，所以可以作为「resume 后能不能看到历史」的自动化判据。
 *
 * 用法：node test/probe-transcript.mjs <threadId> [<threadId> ...]
 */
import { spawn } from 'node:child_process';

const threadIds = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (threadIds.length === 0) {
  console.error('用法：node test/probe-transcript.mjs <threadId> [<threadId> ...]');
  process.exit(2);
}

const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: true,
});

let nextId = 1;
const pending = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.log('  [非 JSON 输出]', line.slice(0, 200));
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve } = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    } else if (message.method) {
      // 通知（thread/started 等），探针不关心
    }
  }
});
child.on('exit', (code) => console.log(`[app-server 退出 code=${code}]`));

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  });
}

function brief(item) {
  if (!item || typeof item !== 'object') return String(item);
  const type = item.type ?? '?';
  const text =
    typeof item.text === 'string'
      ? item.text
      : Array.isArray(item.content)
        ? item.content.map((c) => c.text ?? c.type ?? '').join(' ')
        : typeof item.command === 'string'
          ? item.command
          : '';
  return `${type}${text ? ` :: ${text.replace(/\s+/g, ' ').slice(0, 90)}` : ''}`;
}

try {
  const init = await request('initialize', {
    clientInfo: { name: 'dsh-transcript-probe', title: null, version: '0.0.1' },
    capabilities: null,
  });
  console.log('initialize ->', JSON.stringify(init.result ?? init.error).slice(0, 300));

  for (const threadId of threadIds) {
    console.log(`\n${'='.repeat(72)}\n线程 ${threadId}`);
    const resume = await request('thread/resume', { threadId, excludeTurns: true }, 60000);
    if (resume.error) {
      console.log('  thread/resume 报错:', JSON.stringify(resume.error).slice(0, 500));
    } else {
      const thread = resume.result?.thread ?? resume.result ?? {};
      console.log('  thread:', JSON.stringify({
        id: thread.id,
        historyMode: thread.historyMode,
        status: thread.status,
        cwd: thread.cwd,
        name: thread.name,
        turns: Array.isArray(thread.turns) ? thread.turns.length : undefined,
      }));
    }
    const turns = await request(
      'thread/turns/list',
      { threadId, itemsView: 'full', limit: 100 },
      60000,
    );
    if (turns.error) {
      console.log('  thread/turns/list 报错:', JSON.stringify(turns.error).slice(0, 500));
      continue;
    }
    const data = turns.result?.data ?? [];
    console.log(`  轮次数: ${data.length}`);
    let itemCount = 0;
    for (const turn of data) {
      const items = turn.items ?? [];
      itemCount += items.length;
      console.log(`  --- 轮次 ${turn.id} 状态=${turn.status} itemsView=${turn.itemsView} 条数=${items.length}`);
      for (const item of items) console.log('      ', brief(item));
    }
    console.log(`  可见条目总数: ${itemCount}`);
  }
} catch (error) {
  console.error('探针失败:', error.message);
} finally {
  try { child.stdin.end(); } catch { /* ignore */ }
  setTimeout(() => { child.kill(); process.exit(0); }, 500);
}
