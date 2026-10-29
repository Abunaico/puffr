// Panel stylesheet. 'puffr' is the Abunai Co arcade look shared with the
// puffr-burn --html report (sky/navy/amber, 3px borders, hard offset shadows,
// monospace headings, scanlines). 'editor' maps the same tokens onto VS Code's
// theme variables for anyone who wants the panel to blend in.
//
// Bar colors were checked with the dataviz palette validator: light #E0A526 is
// 2.19:1 on white, so every bar carries a printed value (relief rule) and a navy
// edge; dark uses #C08A1A because the brand #F2C230 sits above the dark
// lightness band and glares on navy.
'use strict';
const fs = require('fs');
const path = require('path');

const LIGHT = `--bg:#A9D5FA; --panel:#FFFFFF; --ink:#0B2350; --dim:#5E7088; --line:#0B2350; --rule:#C9DDF2;
  --head:#0B2350; --head-ink:#F2C230; --hover:#E8F3FD; --accent:#E0A526; --bar:#E0A526; --meter:#1E6FD9;
  --ok:#7DBEF5; --ok-ink:#0B2350; --warn:#F2602B; --warn-ink:#0B2350; --bad:#C9431A; --bad-ink:#FFFFFF;
  --live:#1F8A3A; --shadow:#0B2350; --tab:#7DBEF5; --scan:rgba(11,35,80,.05); color-scheme:light;
  --pill-bg:#0B2350; --pill-ink:#FFFFFF; --pct-bg:#FFFFFF; --pct-ink:#0B2350; --btn-bg:#0B2350; --btn-ink:#FFFFFF; --btn-glow:#E0A526;`;
const DARK = `--bg:#0B2350; --panel:#10162E; --ink:#E4DEFF; --dim:#B3A8FF; --line:#3B2EA0; --rule:#1E2550;
  --head:#3B2EA0; --head-ink:#F2C230; --hover:#18204A; --accent:#F2C230; --bar:#C08A1A; --meter:#7DBEF5;
  --ok:#1E2550; --ok-ink:#E4DEFF; --warn:#F2602B; --warn-ink:#0B2350; --bad:#E0402A; --bad-ink:#FFFFFF;
  --live:#3BD44F; --shadow:#000000; --tab:#1E2550; --scan:rgba(0,0,0,.18); color-scheme:dark;
  --pill-bg:#F2C230; --pill-ink:#0B2350; --pct-bg:#10162E; --pct-ink:#E4DEFF; --btn-bg:#F2C230; --btn-ink:#0B2350; --btn-glow:#000000;`;
const EDITOR = `--bg:var(--vscode-sideBar-background, var(--vscode-editor-background));
  --panel:var(--vscode-editorWidget-background, var(--vscode-editor-background)); --ink:var(--vscode-foreground);
  --dim:var(--vscode-descriptionForeground); --line:var(--vscode-widget-border, var(--vscode-panel-border, #8884));
  --rule:var(--vscode-widget-border, #8883); --head:var(--vscode-editorWidget-background); --head-ink:var(--vscode-foreground);
  --hover:var(--vscode-list-hoverBackground); --accent:var(--vscode-charts-yellow, #E0A526); --bar:var(--vscode-charts-blue, #3987e5);
  --meter:var(--vscode-charts-blue, #3987e5); --ok:transparent; --ok-ink:var(--vscode-descriptionForeground);
  --warn:#fab219; --warn-ink:#1a1a19; --bad:#d03b3b; --bad-ink:#FFFFFF; --live:#0ca30c; --shadow:transparent;
  --tab:var(--vscode-button-secondaryBackground, transparent); --scan:transparent;
  --pill-bg:var(--vscode-badge-background); --pill-ink:var(--vscode-badge-foreground); --pct-bg:transparent; --pct-ink:var(--vscode-foreground);
  --btn-bg:var(--vscode-button-background); --btn-ink:var(--vscode-button-foreground); --btn-glow:transparent;`;

const asset = name => {
  try { return `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'assets', name)).toString('base64')}`; } catch { return null; }
};
const FISH = { flat: asset('puffr-flat.png'), puff: asset('puffr-puff.png') };

function fishMarkup() {
  if (!FISH.flat || !FISH.puff) return '<span class="fish-emoji" aria-hidden="true">🐡</span>';
  return `<span class="fishes" aria-hidden="true"><img class="flat" src="${FISH.flat}" alt=""><img class="puff" src="${FISH.puff}" alt=""></span>`;
}

function css(theme) {
  const tokens = theme === 'editor'
    ? `:root{${EDITOR}}`
    : `:root{${LIGHT}}
  @media (prefers-color-scheme: dark){ :root{${DARK}} }
  body.vscode-light{${LIGHT}}
  body.vscode-dark, body.vscode-high-contrast{${DARK}}`;
  return `
  ${tokens}
  :root{ --bw:var(--bw-override, 3px); --sh:var(--sh-override, 4px); --radius:var(--radius-override, 0px);
    --pixel:ui-monospace,"SF Mono",Menlo,Consolas,"Courier New",monospace; --body:ui-sans-serif,system-ui,"Segoe UI",sans-serif; }
  ${theme === 'editor' ? ':root{ --bw-override:1px; --sh-override:0px; --radius-override:6px; --pixel:var(--vscode-font-family); --body:var(--vscode-font-family); }' : ''}
  * { box-sizing: border-box; }
  body { margin:0; padding:14px 12px 24px; color:var(--ink); background:var(--bg); font:13px/1.45 var(--body);
    background-image:repeating-linear-gradient(0deg,transparent 0 3px,var(--scan) 3px 4px); transition:opacity .15s; }
  body.busy { opacity:.55; pointer-events:none; }
  .wrap { max-width:1040px; margin:0 auto; display:grid; gap:14px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
  h1 { font:800 18px/1.15 var(--pixel); text-transform:uppercase; letter-spacing:.06em; margin:0; padding:6px 12px;
    background:var(--head); color:#FFFFFF; border:var(--bw) solid var(--line); box-shadow:var(--sh) var(--sh) 0 var(--shadow);
    border-radius:var(--radius); display:inline-flex; align-items:center; gap:6px; }
  h1 em { font-style:normal; color:var(--head-ink); }
  h1 .fishes { position:relative; display:inline-block; width:56px; height:40px; margin:-12px 0 -12px -6px; }
  h1 .fishes img { position:absolute; inset:0; width:100%; height:100%; image-rendering:pixelated; transition:opacity .12s steps(2); }
  h1 .puff, h1:hover .flat { opacity:0; }
  h1:hover .puff { opacity:1; }
  .header-side { display:flex; align-items:center; gap:8px; }
  .dim { color:var(--dim); }
  .stamp { font:11px var(--pixel); color:var(--dim); }
  .kpis { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:10px; }
  @media (min-width:640px) { .kpis { grid-template-columns:repeat(4, minmax(0,1fr)); } }
  .tile, .card { background:var(--panel); border:var(--bw) solid var(--line); box-shadow:var(--sh) var(--sh) 0 var(--shadow);
    border-radius:var(--radius); min-width:0; }
  .tile { padding:8px 12px; }
  .tile-label { font:700 10.5px var(--pixel); text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
  .tile-value { font:800 22px/1.2 var(--pixel); font-variant-numeric:tabular-nums; margin:2px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tile-sub { font-size:11px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .card { padding:0 0 12px; overflow:hidden; }
  .card > :not(h2) { margin-left:14px; margin-right:14px; }
  .card h2 { font:800 12px/1.2 var(--pixel); text-transform:uppercase; letter-spacing:.06em; margin:0 0 10px; padding:7px 14px;
    background:var(--head); color:var(--head-ink); display:flex; align-items:center; gap:8px; }
  .card h2::before { content:"🐡"; font-size:13px; }
  .sub-head { font:700 10.5px var(--pixel); color:var(--dim); text-transform:uppercase; letter-spacing:.06em; margin:14px 0 6px; }
  .sub-head:first-of-type { margin-top:0; }
  .sub-head.row { display:flex; justify-content:space-between; align-items:center; }
  .grid-2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(300px,100%),1fr)); gap:14px; }
  .grid-2 > *, .levers > *, .insights > *, .bars > * { min-width:0; }
  .ctx-title { font-weight:700; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ctx-meta { display:flex; gap:8px; align-items:center; margin:4px 0 10px; font-size:11px; min-width:0; }
  .ctx-meta .dim { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip { display:inline-block; font:700 10.5px var(--pixel); padding:1px 7px; border:2px solid var(--line); background:var(--tab);
    color:var(--ink); white-space:nowrap; margin-right:6px; border-radius:var(--radius); }
  .open-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(300px,100%),1fr)); gap:12px; }
  .open-session { border:2px solid var(--line); padding:10px 12px; min-width:0; border-radius:var(--radius); }
  .open-session.mine { box-shadow:3px 3px 0 var(--shadow); background:var(--hover); }
  .open-session .ctx-title { display:flex; align-items:center; gap:8px; }
  .chip.here { background:var(--pill-bg); color:var(--pill-ink); }
  .filling { margin-top:8px; }
  .filling summary { font:700 10.5px var(--pixel); text-transform:uppercase; letter-spacing:.06em; color:var(--dim); cursor:pointer; margin-bottom:6px; }
  .instr-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
  .instr-total { font:800 20px var(--pixel); }
  .instr-move { margin-top:10px; }
  .meter { position:relative; height:14px; background:var(--rule); border:2px solid var(--line); border-radius:var(--radius); }
  .meter-fill { height:100%; }
  .meter-mark { position:absolute; top:-5px; bottom:-5px; width:3px; background:var(--line); }
  .meter-row { display:flex; justify-content:space-between; align-items:center; margin-top:8px; gap:8px; flex-wrap:wrap; }
  .meter-row strong { font:800 15px var(--pixel); }
  .badge { font:700 10.5px var(--pixel); text-transform:uppercase; letter-spacing:.04em; padding:2px 8px; border:2px solid var(--line);
    box-shadow:2px 2px 0 var(--shadow); white-space:nowrap; border-radius:var(--radius); }
  .badge.ok { background:var(--ok); color:var(--ok-ink); }
  .badge.warning { background:var(--warn); color:var(--warn-ink); }
  .badge.critical { background:var(--bad); color:var(--bad-ink); }
  .bars { display:grid; gap:7px; }
  .bar-row { display:grid; grid-template-columns:minmax(70px,34%) 1fr auto; align-items:center; gap:8px; }
  .bar-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
  .bar { height:10px; background:var(--bar); box-shadow:1px 1px 0 var(--shadow); outline:1px solid var(--line); }
  .bar-row:hover .bar { filter:brightness(1.12); }
  .bar-row:hover .bar-label { color:var(--ink); text-decoration:underline; }
  .bar-value { font:700 12px var(--pixel); font-variant-numeric:tabular-nums; text-align:right; min-width:56px; }
  .insights { display:grid; gap:10px; counter-reset:ins; }
  .insight { display:grid; grid-template-columns:auto 1fr; column-gap:10px; counter-increment:ins; }
  .insight::before { content:counter(ins); font:800 12px var(--pixel); color:var(--pill-ink); background:var(--pill-bg); padding:1px 6px;
    box-shadow:2px 2px 0 var(--shadow); align-self:start; grid-row:span 3; }
  .insight-title { font-weight:700; }
  .insight-pattern { color:var(--dim); font-size:12px; margin-top:2px; }
  .insight-action { margin-top:3px; font-size:12px; }
  .arrow { color:var(--accent); font-weight:800; margin-right:6px; }
  .levers { display:grid; gap:6px; }
  .lever { border:2px solid var(--line); background:var(--panel); padding:6px 10px; border-radius:var(--radius); }
  .lever[open] { box-shadow:3px 3px 0 var(--shadow); }
  .lever summary { min-width:0; display:flex; justify-content:space-between; align-items:center; gap:8px; cursor:pointer; list-style:none; }
  .lever summary::-webkit-details-marker { display:none; }
  .lever summary::before { content:'▸'; color:var(--accent); font-weight:800; margin-right:6px; }
  .lever[open] summary::before { content:'▾'; }
  .lever:hover { background:var(--hover); }
  .lever-title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
  .lever[open] .insight-pattern { margin-top:6px; }
  .pill, .pct { font:800 11.5px/1.5 var(--pixel); font-variant-numeric:tabular-nums; padding:1px 8px; border:2px solid var(--line);
    white-space:nowrap; border-radius:var(--radius); }
  .pill { background:var(--pill-bg); color:var(--pill-ink); }
  .pct { background:var(--pct-bg); color:var(--pct-ink); min-width:96px; text-align:right; font-weight:700; }
  .foot { font-size:11px; color:var(--dim); margin-top:8px; }
  .sessions { display:grid; }
  .session { display:grid; grid-template-columns:10px 1fr auto; gap:10px; align-items:center; padding:6px 0; border-top:1px solid var(--rule); }
  .session:first-child { border-top:0; padding-top:0; }
  .session:hover { background:var(--hover); }
  .session-main { min-width:0; }
  .session-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .session-meta { font-size:11px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .session-cost { font:700 12px var(--pixel); font-variant-numeric:tabular-nums; }
  .dot { width:9px; height:9px; border:2px solid var(--dim); }
  .dot.live { background:var(--live); border-color:var(--line); }
  .accounts { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(220px,100%),1fr)); gap:8px; }
  .account { border:2px solid var(--line); padding:6px 10px; min-width:0; border-radius:var(--radius); }
  .account.active { background:var(--hover); box-shadow:3px 3px 0 var(--shadow); }
  .account-email { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .account-meta { font-size:11px; color:var(--dim); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .empty { color:var(--dim); margin:0; font-size:12px; }
  button { font:700 12px var(--pixel); text-transform:uppercase; letter-spacing:.05em; color:var(--btn-ink); background:var(--btn-bg);
    border:var(--bw) solid var(--line); box-shadow:3px 3px 0 var(--btn-glow); padding:5px 14px; cursor:pointer; border-radius:var(--radius); }
  button:hover { box-shadow:4px 4px 0 var(--btn-glow); transform:translate(-1px,-1px); }
  button:active { transform:translate(2px,2px); box-shadow:1px 1px 0 var(--btn-glow); }
  button:focus-visible { outline:3px solid var(--meter); outline-offset:2px; }
  button.ghost { background:var(--panel); color:var(--ink); border-width:2px; box-shadow:2px 2px 0 var(--shadow); padding:3px 10px; font-size:11px; }
  button.ghost:hover { background:var(--hover); box-shadow:3px 3px 0 var(--shadow); }
  .errors { color:var(--bad); font-size:11px; background:var(--panel); border:2px dashed var(--line); padding:6px 10px; }
  @media (max-width:360px) {
    body { padding:10px 8px; }
    .tile-value { font-size:18px; }
    .bar-row { grid-template-columns:1fr auto; }
    .bar-row .bar-track { grid-column:1 / -1; grid-row:2; }
  }`;
}

module.exports = { css, fishMarkup };
