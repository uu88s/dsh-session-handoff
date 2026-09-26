/**
 * DSH 会话交接 — 浏览器半边。
 *
 * 约定（技能 cordis-plugin-development）：
 *   - 入口顶层只有这一个 `window.__ModuleLoader__.load(...)`，`id` 必须等于包名；
 *   - 只 `require('react')`（基线模块表），不 require 任何 Harness Client 包；
 *   - 不写 DOM、不碰 document.body，一切通过槽位注入；
 *   - 样式只用主题令牌（取不到时退回系统色 Canvas/CanvasText，自动跟随明暗主题）。
 */
window.__ModuleLoader__.load({
  id: '@uu88s/dsh-session-handoff',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = '@uu88s/dsh-session-handoff';
    const ROUTE = '/api/session-handoff';

    const DICT = {
      zh: {
        'row.handoff': '交接给 codex',
        'menu.copyId': '复制 DSH 会话 id',
        'menu.handoff': '交接给 codex…',
        'header.handoff': '交接',
        'busy.plan': '正在预演交接…',
        'busy.write': '正在写入 codex 会话库…',
        'plan.title': '确认交接给 codex？',
        'plan.source': '源会话',
        'plan.target': '目标会话',
        'plan.files': '将写入的文件',
        'plan.rows': '索引登记',
        'plan.confirm': '开始写入',
        'plan.cancel': '取消',
        'done.title': '交接完成，建议复制恢复命令',
        'done.copy': '复制恢复命令',
        'done.undo': '撤销这次交接',
        'done.close': '关闭',
        'done.undoing': '正在撤销…',
        'done.undone': '已撤销，codex 里不会再看到这次交接的会话',
        'info.copiedId': '已复制会话 id：',
        'info.copiedCommand': '已复制恢复命令',
        'info.copyFailed': '复制失败，请手动选中文本复制',
        'error.title': '交接失败',
      },
      en: {
        'row.handoff': 'Hand off to codex',
        'menu.copyId': 'Copy DSH session id',
        'menu.handoff': 'Hand off to codex…',
        'header.handoff': 'Handoff',
        'busy.plan': 'Preparing the handoff…',
        'busy.write': 'Writing into the codex store…',
        'plan.title': 'Hand off this session to codex?',
        'plan.source': 'Source session',
        'plan.target': 'Target session',
        'plan.files': 'Files to create',
        'plan.rows': 'Index row',
        'plan.confirm': 'Write now',
        'plan.cancel': 'Cancel',
        'done.title': 'Handoff complete — copy the resume command',
        'done.copy': 'Copy resume command',
        'done.undo': 'Undo this handoff',
        'done.close': 'Close',
        'done.undoing': 'Undoing…',
        'done.undone': 'Undone — codex no longer sees this session',
        'info.copiedId': 'Copied session id: ',
        'info.copiedCommand': 'Copied the resume command',
        'info.copyFailed': 'Copy failed — select the text and copy manually',
        'error.title': 'Handoff failed',
      },
    };
    const LANG =
      typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language.startsWith('zh')
        ? 'zh'
        : 'en';
    const t = (key) => DICT[LANG][key] ?? DICT.zh[key] ?? key;

    /* ---------------------------------------------------------------- 状态 */

    const store = { state: null, listeners: new Set(), seq: 0 };
    function publish(next) {
      store.state = next;
      store.seq += 1;
      for (const listener of store.listeners) listener();
    }
    function useStore() {
      const [tick, setTick] = React.useState(store.seq);
      React.useEffect(() => {
        const listener = () => setTick(store.seq);
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      }, []);
      void tick;
      return store.state;
    }

    /* ------------------------------------------------------------ 与宿主通信 */

    async function callHost(payload) {
      try {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        let data;
        try {
          data = await response.json();
        } catch {
          data = { ok: false, error: `HTTP ${String(response.status)}` };
        }
        if (data === null || typeof data !== 'object') return { ok: false, error: `HTTP ${String(response.status)}` };
        return data;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    }

    /* -------------------------------------------------------------- 动作 */

    async function copySessionId(sessionId) {
      const ok = await copyText(sessionId);
      publish(
        ok
          ? { kind: 'info', title: `${t('info.copiedId')}${sessionId}` }
          : { kind: 'error', title: t('error.title'), message: t('info.copyFailed'), detail: sessionId },
      );
    }

    async function planHandoff(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        publish({ kind: 'error', title: t('error.title'), message: '没有拿到会话 id' });
        return;
      }
      publish({ kind: 'busy', title: t('busy.plan'), sessionId });
      const data = await callHost({ action: 'plan', sessionId });
      if (data.ok !== true) {
        publish({
          kind: 'error',
          title: t('error.title'),
          message: String(data.error ?? '未知错误'),
          detail: Array.isArray(data.preflight?.errors) ? data.preflight.errors.join('\n') : undefined,
        });
        return;
      }
      publish({
        kind: 'plan',
        title: t('plan.title'),
        sessionId,
        planToken: data.planToken,
        described: data.described,
      });
    }

    async function confirmHandoff(planToken, sessionId) {
      publish({ kind: 'busy', title: t('busy.write'), sessionId });
      const data = await callHost({ action: 'handoff', planToken, sessionId });
      if (data.ok !== true) {
        publish({ kind: 'error', title: t('error.title'), message: String(data.error ?? '未知错误') });
        return;
      }
      publish({
        kind: 'done',
        title: t('done.title'),
        sessionId,
        described: data.described,
        recordId: data.recordId,
        resumeCommand: data.described?.resumeCommand,
      });
    }

    async function undoHandoff(recordId) {
      publish({ kind: 'busy', title: t('done.undoing') });
      const data = await callHost({ action: 'undo', recordId });
      if (data.ok !== true) {
        publish({ kind: 'error', title: t('error.title'), message: String(data.error ?? '未知错误') });
        return;
      }
      publish({ kind: 'info', title: t('done.undone') });
    }

    /* -------------------------------------------------------------- 样式 */

    /* 只使用 dsh-client-ui-theme 真正定义的令牌（名字全部核对过），
       取不到时退回系统色；数值一律抄 DSH 自己的 CSS，保证与侧边栏一致。 */
    const TOKEN = {
      label: 'var(--dsw-alias-label-primary, CanvasText)',
      secondary: 'var(--dsw-alias-label-secondary, CanvasText)',
      tertiary: 'var(--dsw-alias-label-tertiary, GrayText)',
      menuIcon: 'var(--dsw-alias-menu-icon, GrayText)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))',
      surface: 'var(--dsw-menu-surface-fill, Canvas)',
      codeBg: 'var(--dsw-alias-markdown-code-block, rgba(127,127,127,.10))',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
      borderL3: 'var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
      elevation: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0,0,0,.22))',
      error: 'var(--dsw-alias-state-error-primary, #d4380d)',
      business: 'var(--dsw-alias-state-business-primary, #1677ff)',
      primaryFill: 'var(--dsw-alias-button-primary-fill, #1677ff)',
      primaryHover: 'var(--dsw-alias-button-primary-hover, #4096ff)',
      primaryForeground: 'var(--dsw-alias-label-primary-foreground, #fff)',
      radiusXs: 'var(--dsw-radius-xs, 4px)',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
      radius: 'var(--dsw-radius-md, 8px)',
      radiusLg: 'var(--dsw-radius-lg, 12px)',
    };

    function IconHandoff({ size = 14 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M6 3.5h6.5V10' }),
        h('path', { d: 'M12.5 3.5 7.5 8.5' }),
        h('path', { d: 'M13 11.5v1.2a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8V4.8a.8.8 0 0 1 .8-.8h1.2' }),
      );
    }

    /** 抄自 DSH 会话行的 `.iconButton`（内置 pin/archive 用的就是它）。 */
    function iconButtonStyle(hover, color) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        padding: 0,
        flex: 'none',
        border: 'none',
        borderRadius: TOKEN.radiusXs,
        background: 'transparent',
        color: hover ? TOKEN.label : color ?? TOKEN.tertiary,
        cursor: 'pointer',
      };
    }

    function HoverIconButton({ title, onClick, color, size = 14 }) {
      const [hover, setHover] = React.useState(false);
      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': title,
          onClick: (event) => {
            event.stopPropagation();
            event.preventDefault();
            onClick();
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: iconButtonStyle(hover, color),
        },
        h(IconHandoff, { size }),
      );
    }

    /** 抄自 DSH 菜单项的 `.item`（Menu.module.css）。 */
    function menuRowStyle(hover) {
      return {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        minHeight: 34,
        padding: '6px 8px',
        border: 'none',
        borderRadius: TOKEN.radius,
        background: hover ? TOKEN.hover : 'transparent',
        color: TOKEN.label,
        fontSize: 13,
        lineHeight: '20px',
        textAlign: 'left',
        cursor: 'pointer',
      };
    }

    function MenuRow({ label, onClick }) {
      const [hover, setHover] = React.useState(false);
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          onClick: (event) => {
            event.stopPropagation();
            onClick();
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: menuRowStyle(hover),
        },
        h('span', { style: { display: 'inline-flex', flex: 'none', color: TOKEN.menuIcon } }, h(IconHandoff, { size: 14 })),
        h(
          'span',
          { style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
          label,
        ),
      );
    }

    /* ------------------------------------------------------------ 槽位条目 */

    /** 菜单槽位给了 `useMenuOpenState()`，拿不到时也不能让条目崩掉。 */
    function useMenuCloser(useMenuOpenState) {
      if (typeof useMenuOpenState !== 'function') return () => {};
      const [, setMenuOpen] = useMenuOpenState();
      return () => setMenuOpen(false);
    }

    function CopySessionIdMenuItem(props) {
      const { sessionId } = props;
      const closeMenu = useMenuCloser(props.useMenuOpenState);
      return h(MenuRow, {
        label: t('menu.copyId'),
        onClick: () => {
          closeMenu();
          void copySessionId(sessionId);
        },
      });
    }

    function HandoffMenuItem(props) {
      const { sessionId } = props;
      const closeMenu = useMenuCloser(props.useMenuOpenState);
      return h(MenuRow, {
        label: t('menu.handoff'),
        onClick: () => {
          closeMenu();
          void planHandoff(sessionId);
        },
      });
    }

    function SessionRowHandoffButton({ sessionId, displayTitle }) {
      void displayTitle;
      return h(HoverIconButton, {
        title: t('row.handoff'),
        onClick: () => {
          void planHandoff(sessionId);
        },
      });
    }

    /** 抄自 DSH 会话头部动作按钮（ui-jobs 的 trigger：12px/18px、无边框、悬停换色）。 */
    function HeaderHandoffButton({ sessionId }) {
      const [hover, setHover] = React.useState(false);
      return h(
        'button',
        {
          type: 'button',
          title: t('row.handoff'),
          'aria-label': t('row.handoff'),
          onClick: () => {
            void planHandoff(sessionId);
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            minHeight: 28,
            padding: '3px 2px',
            border: 0,
            borderRadius: TOKEN.radiusSm,
            background: 'transparent',
            color: hover ? TOKEN.label : TOKEN.tertiary,
            fontSize: 12,
            lineHeight: '18px',
            cursor: 'pointer',
          },
        },
        h(IconHandoff, { size: 14 }),
        h('span', { style: { whiteSpace: 'nowrap' } }, t('header.handoff')),
      );
    }

    /* ---------------------------------------------------------------- 浮层 */

    /** 抄自 DSH 的 Button `.sm`（12px/18px、高 28、圆角 sm）。 */
    function ActionButton({ label, onClick, primary }) {
      const [hover, setHover] = React.useState(false);
      return h(
        'button',
        {
          type: 'button',
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 28,
            padding: '0 10px',
            border: primary ? 'none' : `0.5px solid ${TOKEN.borderL3}`,
            borderRadius: TOKEN.radiusSm,
            background: primary
              ? hover
                ? TOKEN.primaryHover
                : TOKEN.primaryFill
              : hover
                ? TOKEN.hover
                : 'transparent',
            color: primary ? TOKEN.primaryForeground : TOKEN.label,
            fontSize: 12,
            lineHeight: '18px',
            cursor: 'pointer',
          },
        },
        label,
      );
    }

    function PathList({ lines }) {
      const [open, setOpen] = React.useState(false);
      if (!Array.isArray(lines) || lines.length === 0) return null;
      return h(
        'div',
        { style: { marginTop: 6 } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((value) => !value),
            style: {
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: TOKEN.business,
              fontSize: 12,
              lineHeight: '18px',
              cursor: 'pointer',
            },
          },
          `${open ? '▾' : '▸'} ${t('plan.files')}（${String(lines.length)}）`,
        ),
        open
          ? h(
              'ul',
              {
                style: {
                  margin: '4px 0 0',
                  padding: '0 0 0 16px',
                  color: TOKEN.tertiary,
                  fontSize: 12,
                  lineHeight: '18px',
                },
              },
              ...lines.map((line, index) => h('li', { key: `${String(index)}:${line}`, style: { wordBreak: 'break-all' } }, line)),
            )
          : null,
      );
    }

    function ToastLayer() {
      const state = useStore();
      const kind = state?.kind;
      React.useEffect(() => {
        /* 定时器必须核对「浮层还是我这一条」再关：否则用户已经点了别的按钮，
           旧的定时器会把新提示一起清掉。 */
        if (kind === 'info') {
          const timer = setTimeout(() => {
            if (store.state === state) publish(null);
          }, 4000);
          return () => clearTimeout(timer);
        }
        if (kind === 'error') {
          const timer = setTimeout(() => {
            if (store.state === state) publish(null);
          }, 9000);
          return () => clearTimeout(timer);
        }
        if (kind === 'done' && state?.copied === true) {
          const timer = setTimeout(() => {
            if (store.state === state) publish({ ...state, copied: false });
          }, 3000);
          return () => clearTimeout(timer);
        }
        return undefined;
      }, [state, kind]);
      if (state === null || state === undefined) return null;

      const described = state.described;
      const children = [];
      children.push(
        h(
          'div',
          {
            key: 'title',
            style: {
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              color: kind === 'error' ? TOKEN.error : TOKEN.label,
              fontSize: 14,
              lineHeight: '22px',
              fontWeight: 600,
            },
          },
          h('span', null, state.title),
          h(
            'button',
            {
              type: 'button',
              onClick: () => publish(null),
              style: {
                border: 'none',
                background: 'transparent',
                color: TOKEN.tertiary,
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
              },
            },
            '×',
          ),
        ),
      );

      if (kind === 'error') {
        children.push(
          h('div', { key: 'message', style: { marginTop: 6, color: TOKEN.secondary, fontSize: 13, lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, state.message),
        );
        if (typeof state.detail === 'string' && state.detail.length > 0) {
          children.push(
            h('pre', { key: 'detail', style: { margin: '6px 0 0', color: TOKEN.tertiary, fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap' } }, state.detail),
          );
        }
      }

      if (kind === 'plan' && described !== undefined) {
        children.push(
          h(
            'div',
            { key: 'meta', style: { marginTop: 6, color: TOKEN.secondary, fontSize: 13, lineHeight: '20px', wordBreak: 'break-all' } },
            `${t('plan.source')}：${String(described.sessionId)}`,
            h('br'),
            `${t('plan.target')}：codex / ${String(described.threadId)}`,
            h('br'),
            `${t('plan.rows')}：threads.id=${String(described.threadId)}`,
          ),
        );
        children.push(h(PathList, { key: 'files', lines: described.files }));
        children.push(
          h(
            'div',
            { key: 'actions', style: { display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' } },
            h(ActionButton, { label: t('plan.cancel'), onClick: () => publish(null) }),
            h(ActionButton, {
              label: t('plan.confirm'),
              primary: true,
              onClick: () => {
                void confirmHandoff(state.planToken, state.sessionId);
              },
            }),
          ),
        );
      }

      if (kind === 'done') {
        const command = state.resumeCommand ?? described?.resumeCommand ?? '';
        children.push(
          h(
            'pre',
            {
              key: 'command',
              style: {
                margin: '8px 0 0',
                padding: '6px 8px',
                border: `0.5px solid ${TOKEN.border}`,
                borderRadius: TOKEN.radiusSm,
                background: TOKEN.codeBg,
                color: TOKEN.label,
                fontFamily: 'var(--dsw-font-markdown-code-font-family, monospace)',
                fontSize: 'var(--dsw-font-markdown-code-font-size, 12px)',
                lineHeight: '18px',
                userSelect: 'all',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              },
            },
            command,
          ),
        );
        if (state.copied === true) {
          children.push(
            h(
              'div',
              { key: 'copied', style: { marginTop: 6, color: TOKEN.business, fontSize: 13, lineHeight: '20px' } },
              t('info.copiedCommand'),
            ),
          );
        }
        children.push(h(PathList, { key: 'files', lines: described?.files }));
        children.push(
          h(
            'div',
            { key: 'actions', style: { display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' } },
            h(ActionButton, {
              label: t('done.undo'),
              onClick: () => {
                void undoHandoff(state.recordId);
              },
            }),
            h(ActionButton, {
              label: t('done.copy'),
              primary: true,
              onClick: () => {
                void (async () => {
                  const ok = await copyText(command);
                  /* 复制成功不换掉这条浮层，否则「撤销」按钮会跟着消失。 */
                  if (ok) publish({ ...state, copied: true });
                  else publish({ kind: 'error', title: t('error.title'), message: t('info.copyFailed'), detail: command });
                })();
              },
            }),
          ),
        );
      }

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 9999,
            maxWidth: 460,
            minWidth: 300,
            padding: '12px 16px',
            border: `0.5px solid ${TOKEN.border}`,
            borderRadius: TOKEN.radiusLg,
            background: TOKEN.surface,
            color: TOKEN.label,
            boxShadow: TOKEN.elevation,
            pointerEvents: 'auto',
          },
        },
        ...children,
      );
    }

    /* ------------------------------------------------------------ 插件主体 */

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale !== undefined && typeof locale.register === 'function') {
          try {
            ctx.effect(() => locale.register(NS, DICT), 'session-handoff: dictionaries');
          } catch {
            // 词典只是锦上添花，失败不影响功能。
          }
        }

        const register = (slot, entry, Component) => {
          if (typeof ctx.slots?.inject !== 'function') return;
          ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, ...entry }, Component));
        };

        register('sidebar.workspaces.session.row.action', { id: 'session-handoff', order: 250 }, SessionRowHandoffButton);
        register('sidebar.workspaces.session.menu.item', { id: 'session-handoff-copy-id', order: 500 }, CopySessionIdMenuItem);
        register('sidebar.workspaces.session.menu.item', { id: 'session-handoff-to-codex', order: 600 }, HandoffMenuItem);
        register('conversation.session.header.actions', { id: 'session-handoff', order: 30 }, HeaderHandoffButton);
        register('shell.overlay', { id: 'session-handoff-toast' }, ToastLayer);
      },
    };
  },
});
