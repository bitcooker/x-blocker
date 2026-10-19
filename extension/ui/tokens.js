// SPDX-License-Identifier: GPL-3.0-or-later
// X Blocker design system: one source for colours, type and the small set of
// shared components, used by the dashboard, the toolbar popup and the in-page
// UI on x.com (inside its shadow root).
//
// Colour has one meaning each, everything else stays neutral:
//   danger (red)  – blocking and destructive actions
//   accent (blue) – progress, links, focus
//   ok (green)    – done
//   warn (amber)  – waiting (paused, rate limit, safety limit)
//
// Loaded as a classic script so it works both as a content script (where it
// only defines XB_STYLE) and in extension pages (where it also applies itself).
(() => {
  'use strict'
  if (globalThis.XB_STYLE) return

  const THEMES = {
    light: {
      bg: '#ffffff', 'bg-elev': '#ffffff', 'bg-subtle': '#f7f9f9', hover: 'rgba(15,20,25,.06)',
      fg: '#0f1419', muted: '#536471', border: '#eff3f4', 'border-strong': '#cfd9de',
      shadow: '0 8px 28px rgba(101,119,134,.18),0 1px 3px rgba(101,119,134,.15)', backdrop: 'rgba(0,0,0,.4)',
    },
    dim: {
      bg: '#15202b', 'bg-elev': '#1e2732', 'bg-subtle': '#1e2732', hover: 'rgba(247,249,249,.08)',
      fg: '#f7f9f9', muted: '#8b98a5', border: '#38444d', 'border-strong': '#536471',
      shadow: '0 8px 28px rgba(0,0,0,.45)', backdrop: 'rgba(91,112,131,.4)',
    },
    dark: {
      bg: '#000000', 'bg-elev': '#16181c', 'bg-subtle': '#16181c', hover: 'rgba(231,233,234,.08)',
      fg: '#e7e9ea', muted: '#71767b', border: '#2f3336', 'border-strong': '#536471',
      shadow: '0 8px 28px rgba(0,0,0,.6)', backdrop: 'rgba(91,112,131,.4)',
    },
  }
  const SHARED = {
    accent: '#1d9bf0', 'accent-soft': 'rgba(29,155,240,.12)',
    danger: '#f4212e', 'danger-hover': '#dc1e29', 'danger-soft': 'rgba(244,33,46,.1)',
    ok: '#00ba7c', 'ok-soft': 'rgba(0,186,124,.12)',
    warn: '#ffad1f', 'warn-soft': 'rgba(255,173,31,.15)',
    radius: '16px', 'radius-sm': '8px',
    font: 'TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"Vazirmatn","Noto Sans Arabic",Tahoma,sans-serif',
  }
  const vars = (o) => Object.entries(o).map(([k, v]) => `--${k}:${v}`).join(';')

  // Theme variables for `scope`. 'attr' switches on scope[data-theme=…] (x.com
  // follows X's own theme); 'os' follows the system light/dark setting.
  function tokens(scope, mode = 'attr') {
    const base = `${scope}{${vars(SHARED)};${vars(THEMES.light)}}`
    if (mode === 'os') {
      return `${base}@media (prefers-color-scheme:dark){${scope}{${vars(THEMES.dark)}}}`
    }
    return `${base}${scope}[data-theme=dim]{${vars(THEMES.dim)}}${scope}[data-theme=dark]{${vars(THEMES.dark)}}`
  }

  // Shared components. Tone modifiers: -accent, -ok, -warn, -danger.
  const COMPONENTS = `
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:36px;
  padding:0 16px;border-radius:9999px;border:1px solid var(--border-strong);background:transparent;color:var(--fg);
  font:700 14px/20px var(--font);white-space:nowrap;cursor:pointer;user-select:none;
  transition:background-color .15s,border-color .15s,color .15s,opacity .15s}
.btn:hover:not(:disabled){background:var(--hover)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn:disabled{opacity:.5;cursor:default}
.btn svg{width:18px;height:18px;fill:currentColor;flex:none}
.btn-primary{background:var(--fg);border-color:var(--fg);color:var(--bg)}
.btn-primary:hover:not(:disabled){background:var(--fg);opacity:.85}
.btn-danger{background:var(--danger);border-color:var(--danger);color:#fff}
.btn-danger:hover:not(:disabled){background:var(--danger-hover);border-color:var(--danger-hover)}
.btn-danger-outline{color:var(--danger)}
.btn-danger-outline:hover:not(:disabled){background:var(--danger-soft);border-color:var(--danger)}
.btn-quiet{border-color:transparent;color:var(--muted)}
.btn-quiet:hover:not(:disabled){color:var(--fg)}
.btn-lg{height:44px;padding:0 24px;font-size:15px}
.btn-sm{height:32px;padding:0 12px;font-size:13px}
.btn-xs{height:22px;padding:0 10px;font-size:12px;line-height:20px}
.btn-icon{width:36px;padding:0}
.btn-sm.btn-icon{width:32px}
.btn-block{width:100%}
[dir=rtl] .i-flip{transform:scaleX(-1)}

.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);flex:none}
.dot-accent{background:var(--accent)}.dot-ok{background:var(--ok)}.dot-warn{background:var(--warn)}.dot-danger{background:var(--danger)}
.dot.live{animation:xb-pulse 1.2s ease-in-out infinite}

.meter{height:4px;border-radius:9999px;background:var(--border);overflow:hidden}
.meter>span{display:block;height:100%;width:0;border-radius:inherit;background:var(--accent);transition:width .3s ease}
.meter-ok>span{background:var(--ok)}.meter-warn>span{background:var(--warn)}.meter-danger>span{background:var(--danger)}
.meter.indeterminate>span{width:30%!important;animation:xb-slide 1.4s ease-in-out infinite}
[dir=rtl] .meter.indeterminate>span{animation-name:xb-slide-rtl}

.tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;white-space:nowrap;
  font:600 12px/20px var(--font);background:var(--bg-subtle);color:var(--muted)}
.tag-accent{background:var(--accent-soft);color:var(--accent)}.tag-ok{background:var(--ok-soft);color:var(--ok)}
.tag-warn{background:var(--warn-soft);color:var(--warn)}.tag-danger{background:var(--danger-soft);color:var(--danger)}

.toast{background:var(--fg);color:var(--bg);padding:12px 16px;border-radius:var(--radius-sm);box-shadow:var(--shadow);
  font:15px/20px var(--font);max-width:min(520px,calc(100vw - 32px));animation:xb-fade .2s ease-out}
.toast-danger{background:var(--danger);color:#fff}

@keyframes xb-pulse{50%{opacity:.25}}
@keyframes xb-slide{from{transform:translateX(-100%)}to{transform:translateX(340%)}}
@keyframes xb-slide-rtl{from{transform:translateX(100%)}to{transform:translateX(-340%)}}
@keyframes xb-fade{from{opacity:0}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`

  globalThis.XB_STYLE = { THEMES, SHARED, tokens, components: COMPONENTS }

  // Extension pages (dashboard, popup) apply it right away, before their own
  // stylesheets, which only add page layout on top.
  if (/^(chrome|moz)-extension:$/.test(globalThis.location?.protocol ?? '') && globalThis.document) {
    const style = document.createElement('style')
    style.textContent = tokens(':root', 'os') + COMPONENTS
    document.head.append(style)
  }
})()
