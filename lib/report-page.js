'use strict';
// Shared HTML page for puffr reports (burn, swarm): one self-contained file with report.css and the PUFFR
// art inlined, sortable and filterable tables, and the swimming back-to-top fish. Builtins only, no network.
const fs = require('fs');
const path = require('path');
const PUFFR_ROOT = path.join(__dirname, '..');

const e = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// A cell is text (left-aligned, wraps, sorts A to Z) or [text, sortValue] (a number:
// right-aligned, sorts by the raw value, blanks last).
const td = c => Array.isArray(c)
  ? `<td class="n" data-v="${c[1] != null && Number.isFinite(c[1]) ? c[1] : -1e99}">${c[0]}</td>`
  : `<td>${c}</td>`;
// f = [type, value] makes the row hoverable and clickable (card + drill-down); a string is a static tip.
const row = (cells, kid, f) => `<tr${kid ? ' class="kid"' : ''}${Array.isArray(f) ? ` tabindex="0" data-ft="${e(f[0])}" data-fv="${e(f[1])}"` : f ? ` data-tip="${e(f)}"` : ''}>${cells.map(td).join('')}</tr>`;
// Header alignment follows the first row's cells; tables past 12 rows get a filter box.
const table = (cols, rows) => {
  const num = (rows[0] || '').split('<td').slice(1).map(c => c.startsWith(' class="n"'));
  const filter = rows.length > 12 ? `<div class="tfilter"><input type="search" placeholder="Filter ${rows.length} rows" aria-label="Filter this table"><span></span></div>` : '';
  return `${filter}<div class="wrap"><table class="s"><thead><tr>${cols.map((c, i) => `<th tabindex="0"${num[i] ? ' class="n"' : ''}>${e(c)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
};

// Sorting and filtering for every `table.s` and `.tfilter` box on the page.
const TABLES_JS = `function sortable(t) {
  const hs = [...t.tHead.rows[0].cells], tb = t.tBodies[0];
  hs.forEach((h, i) => {
    const go = () => {
      const d = h.dataset.d === 'desc' ? 'asc' : h.dataset.d === 'asc' ? 'desc' : i ? 'desc' : 'asc';
      hs.forEach(x => delete x.dataset.d); h.dataset.d = d;
      const v = r => { const c = r.cells[i]; return c.dataset.v != null ? +c.dataset.v : c.textContent.trim().toLowerCase(); };
      const cmp = (a, b) => { const x = v(a), y = v(b), r = typeof x === 'number' ? x - y : String(x).localeCompare(y); return d === 'asc' ? r : -r; };
      const groups = [];
      for (const r of tb.rows) r.classList.contains('kid') && groups.length ? groups[groups.length - 1].push(r) : groups.push([r]);
      groups.sort((a, b) => cmp(a[0], b[0]));
      for (const [p, ...kids] of groups) tb.append(p, ...kids.sort(cmp));
    };
    h.onclick = go; h.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); go(); } };
  });
}
document.querySelectorAll('table.s').forEach(sortable);
// Filter: every word must appear in the row. A group (a row and its indented rows)
// shows when its parent or any child matches; a matching parent keeps all its children.
function filterable(box, t) {
  const input = box.querySelector('input'), count = box.querySelector('span'), tb = t.tBodies[0];
  const groups = () => { const g = []; for (const r of tb.rows) r.classList.contains('kid') && g.length ? g[g.length - 1].push(r) : g.push([r]); return g; };
  input.oninput = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = r => words.every(w => r.textContent.toLowerCase().includes(w));
    let shown = 0, total = 0;
    for (const [p, ...kids] of groups()) {
      const ph = hit(p), kh = kids.map(hit), on = ph || kh.some(Boolean);
      p.hidden = !on; kids.forEach((k, i) => { k.hidden = !(ph || kh[i]); });
      total++; if (on) shown++;
    }
    count.textContent = words.length ? shown + ' of ' + total : '';
  };
}
document.querySelectorAll('.tfilter').forEach(b => filterable(b, b.nextElementSibling.querySelector('table')));`;

// The back-to-top fish.
const FISH_JS = `// Back to top: PUFFR swims along the bottom, left near the top of the page, right at the end;
// at the very top he swims off the left edge and comes back in from there.
// He moves in strokes (kick, glide, drift back a little) and turns to face the way he swims.
// Every pose is a held cel from assets/puffr-cels.png, never a tween: the tail sweeps through
// five poses on each kick and follows through to a random one; the top fin lays back with
// speed; the side fin flutters; he blinks (half, closed, half) and pulls faces every 1 to 3
// seconds, resting or swimming.
// Swimming fast leaves spurts of bubbles; the body rocks against each tail beat.
// Click him and he startles. The gag is staged like a cartoon cut: a freeze, an inhale (the
// anticipation), a one-frame pop that overshoots tall then wide, a buoyant float where he rises,
// rolls past his tipping point onto his back and rocks there paddling with bubbles trickling up,
// then the air jet of the deflate spins him upright with a wince, a stretch, a relief blink, a
// then he swims for it still puffed, deflating at half speed as he goes (the air jet spins him
// upright), with a relief blink once he's flat. The page starts gliding up on the click, easing in.
const fish = document.querySelector('.totop');
if (fish) {
  const CEL = { kick: [2, 1, 2, 3, 4, 5, 4], fin: [6, 7, 8], flick: 9, pec: [0, 10, 0, 11], half: 12, blink: 13,
    faces: { happy: 14, sad: 15, wink: 16, surprised: 17, sleepy: 18, determined: 19, silly: 20 } };
  const RESTING = ['happy', 'sad', 'wink', 'surprised', 'sleepy', 'determined', 'silly'];
  const SWIMMING = ['determined', 'determined', 'happy', 'surprised', 'silly', 'wink'];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let x = -80, v = 0, ph = 0, turned = 1, moving = false, scared = false, startled = false, kicking = false;
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const cel = (k, n) => fish.style.setProperty('--' + k, n);
  const goal = () => {
    if (scrollY <= 200) return -120; // near the top he leaves off the left edge
    const room = document.documentElement.scrollHeight - innerHeight;
    return 16 + (room > 0 ? Math.min(1, scrollY / room) : 0) * (innerWidth - 96);
  };
  const ROCK = { 1: -6, 2: -3, 3: 0, 4: 3, 5: 6 }; // body counter-rotation per tail pose
  const beat = t => { cel('tail', t); fish.style.setProperty('--rot', (ROCK[t] * turned) + 'deg'); };
  let lastSpurt = 0;
  const spurt = () => { // a few small bubbles shed behind him when he's going fast
    const now = performance.now(); if (now - lastSpurt < 150) return; lastSpurt = now;
    const r = fish.getBoundingClientRect(), tail = turned > 0 ? r.left + 6 : r.right - 10;
    bubbles(2 + Math.floor(Math.random() * 2), tail, r.top + 22, 4, 7, 0.7);
  };
  const draw = () => { fish.style.transform = 'translateX(' + x.toFixed(1) + 'px)'; fish.classList.toggle('right', turned > 0); fish.classList.toggle('show', x > -74); };
  const calm = () => { scared = startled = false; face = 0; cel('face', 0); go(); };
  const swim = () => {
    if (scared && x <= -90) { moving = kicking = false; v = 0; fish.classList.remove('moving'); fish.style.setProperty('--rot', '0deg'); calm(); return; }
    if (scared) {
      // Fleeing: full-strength kicks all the way off the left edge, quicker strokes, little drift back.
      turned = -1; ph = (ph + 1 / 12) % 1;
      if (ph < 0.3) { v -= fish.classList.contains('puffed') ? 4.5 : 7; beat(CEL.kick[Math.floor(ph / 0.3 * 7)]); kicking = true; }
      else { if (kicking) { kicking = false; beat(1 + Math.floor(Math.random() * 5)); } if (ph > 0.75) v += 0.84; }
      cel('fin', CEL.fin[Math.abs(v) > 7 ? 2 : 1]);
      v *= 0.88; x += v; draw(); if (Math.abs(v) > 8) spurt();
      return requestAnimationFrame(swim);
    }
    const d = goal() - x, dir = Math.sign(d);
    if (Math.abs(d) < 1 && Math.abs(v) < 0.3) { x += d; v = 0; ph = 0; moving = kicking = false; cel('fin', 6); fish.style.setProperty('--rot', '0deg'); fish.classList.remove('moving'); draw(); return; }
    if (Math.abs(d) < 14) { v += d * 0.06; ph = 0; }
    else {
      turned = dir;
      ph = (ph + 1 / 30) % 1;
      const s = Math.min(1.8, Math.abs(d) / 120) + 0.15;
      if (ph < 0.3) { v += dir * 2.4 * s; beat(CEL.kick[Math.floor(ph / 0.3 * 7)]); kicking = true; }
      else {
        if (kicking) { kicking = false; beat(1 + Math.floor(Math.random() * 5)); } // follow-through: any pose
        if (ph > 0.7) v -= dir * 0.5 * s;
      }
    }
    cel('fin', CEL.fin[Math.abs(v) > 7 ? 2 : Math.abs(v) > 3 ? 1 : 0]); // the top fin lays back with speed
    v *= 0.86; x += v; draw(); if (Math.abs(v) > 9) spurt();
    requestAnimationFrame(swim);
  };
  const go = () => {
    if (startled && !scared) return; // mid-gag he holds his spot while the page glides
    if (still) { x = goal(); draw(); if (scared) setTimeout(calm, 600); return; }
    if (!moving) { moving = true; fish.classList.add('moving'); requestAnimationFrame(swim); }
  };
  addEventListener('scroll', go, { passive: true }); addEventListener('resize', go); go();
  // Keep-alive, ticking at about 11 fps like limited animation: side fin flutter, a blink every
  // 2 to 6 seconds, a face every 5 to 20 seconds, and the odd top-fin twitch at rest.
  let face = 0, faceEnd = 0, blink = [], tick = 0;
  const t0 = performance.now(), later = (a, b) => performance.now() + (a + Math.random() * (b - a)) * 1000;
  let nextBlink = t0 + 2000, nextFace = later(5, 20);
  const alive = () => {
    setTimeout(alive, 90);
    if (startled || document.hidden || !fish.classList.contains('show')) return;
    const now = performance.now(); tick++;
    const every = moving ? 2 : 16; // the side fin fans slowly at rest, quicker while swimming
    if (tick % every === 0) cel('pec', CEL.pec[(tick / every) % 4]);
    if (blink.length) { cel('face', blink.shift()); return; }
    if (face && now > faceEnd) { face = 0; blink = [CEL.half, 0]; return; } // ease out of a face through a half-blink
    if (now > nextFace) {
      nextFace = later(5, 20);
      face = CEL.faces[pick(moving ? SWIMMING : RESTING)]; faceEnd = now + 1200 + Math.random() * 1300; blink = [CEL.half, face];
    } else if (!face && now > nextBlink) {
      nextBlink = later(2, 6);
      blink = [CEL.half, CEL.blink, CEL.blink, CEL.half, 0];
      if (!moving && Math.random() < 0.25) { cel('fin', CEL.flick); setTimeout(() => cel('fin', 6), 180); }
    }
  };
  if (!still) setTimeout(alive, 600);
  const bubbles = (n, cx, cy, lo, hi, t, ring) => {
    for (let i = 0; i < n; i++) {
      const a = i / n * 6.283, R = ring ? 20 + Math.random() * 10 : 0, sz = Math.round(lo + Math.random() * (hi - lo));
      const top = cy + Math.sin(a) * R + (ring ? 0 : (Math.random() - 0.5) * 10);
      const keeps = sz >= lo + (hi - lo) * 0.7 || Math.random() < 0.15; // the big ones carry on; the rest pop
      const rise = keeps ? top + sz * 2 + 12 : 30 + Math.random() * 70, dur = keeps ? t * rise / (150 + sz * 14) : 0.45 + Math.random() * 0.6;
      const b = document.createElement('span'); b.className = 'bubble';
      b.style.cssText = 'left:' + (cx + Math.cos(a) * R + (ring ? 0 : (Math.random() - 0.5) * 14)).toFixed(0) + 'px;top:' + top.toFixed(0)
        + 'px;--s:' + sz + 'px;--rise:' + rise.toFixed(0) + 'px;--dx:' + ((keeps ? (Math.random() - .3) * 70 : (Math.random() - .5) * 16)).toFixed(0) + 'px;--g:' + (keeps ? 1.8 : 1.15) + ';--end:' + (keeps ? 0 : 1)
        + ';--w:' + (ring ? Math.cos(a) * 12 : (keeps ? 6 + Math.random() * 8 : 2 + Math.random() * 4) * (Math.random() < .5 ? -1 : 1)).toFixed(1)
        + 'px;--t:' + dur.toFixed(2) + 's;--sw:' + (0.6 + Math.random() * 0.6).toFixed(2) + 's;--wb:' + (0.25 + Math.random() * 0.2).toFixed(2) + 's;--d:' + Math.round(ring ? Math.random() * 40 : i * 60 + Math.random() * 50) + 'ms';
      b.addEventListener('animationend', e => {
        if (e.animationName === 'pop' || (e.animationName === 'rise' && keeps)) return b.remove();
        if (e.animationName !== 'rise') return;
        const c = getComputedStyle(b); // freeze where it got to, then pop there
        b.style.translate = c.translate; b.style.transform = c.transform; b.style.scale = c.scale; b.style.width = c.width; b.style.height = c.height;
        b.classList.add('pop');
      });
      document.body.appendChild(b);
    }
  };
  const body = fish.firstElementChild, box = () => fish.getBoundingClientRect();
  // One pose: translate, roll, squash/stretch. Easing runs from this key to the next; offset is its time.
  const K = (sx, sy, deg, y, dx, easing, offset) => ({ transform: 'translate(' + dx + 'px,' + y + 'px) rotate(' + deg + 'deg) scale(' + sx + ',' + sy + ')', easing, offset });
  const play = (keys, ms, origin) => { body.style.transformOrigin = origin; return body.animate(keys, { duration: ms, fill: 'forwards' }).finished.catch(() => {}); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // The page glides to the top on its own curve: slow to start, settling as it arrives. A wheel or touch cancels it.
  let glideId = 0;
  const glide = ms => {
    const from = scrollY, t0 = performance.now(); cancelAnimationFrame(glideId);
    const step = now => { const p = Math.min(1, (now - t0) / ms), e = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; scrollTo(0, from * (1 - e)); if (p < 1) glideId = requestAnimationFrame(step); };
    glideId = requestAnimationFrame(step);
  };
  for (const ev of ['wheel', 'touchstart']) addEventListener(ev, () => cancelAnimationFrame(glideId), { passive: true });
  const HOLD = 'steps(1, end)', SNAP = 'cubic-bezier(.2,.9,.3,1)', SOFT = 'ease-in-out', TEETER = 'cubic-bezier(.65,0,.35,1)';
  fish.onclick = async () => {
    if (startled) return;
    startled = true; blink = []; face = 0; cel('face', 0); cel('pec', 0); cel('fin', 6);
    if (still) { fish.classList.add('puffed'); await wait(400); fish.classList.remove('puffed'); scared = true; scrollTo({ top: 0 }); go(); return; }
    fish.classList.add('gag'); fish.style.setProperty('--rot', '0deg'); glide(5200);
    // Anticipation: he freezes wide-eyed, then sucks in a breath (squash, the opposite of the pop).
    cel('face', CEL.faces.surprised);
    await play([K(1, 1, 0, 0, 0, HOLD, 0), K(1, 1, 0, 0, 0, 'ease-out', .43), K(1.07, .8, 0, 2, 0, HOLD, .86), K(1.07, .8, 0, 2, 0, HOLD, 1)], 420, '50% 100%');
    // The pop: one frame tall, two frames wide and squashed, settle. Water flies out as a ring of bubbles.
    fish.classList.add('puffed'); cel('face', 0);
    let r = box(); bubbles(8, r.left + 32, r.top + 28, 5, 10, .9, true);
    let paddle = 0; const fins = setInterval(() => fish.style.setProperty('--pf', [0, 1, 0, 2][paddle++ % 4]), 70);
    const trickle = setInterval(() => { const q = box(); bubbles(1, q.left + 16 + Math.random() * 32, q.top + 6, 4, 7, .9); }, 380);
    // Then the float: buoyant, he rises and rolls, slowly at first, past the tipping point onto his
    // back, and rocks there. Never still, like the real fish.
    await play([
      K(.9, 1.24, 0, -10, 0, HOLD, 0), K(1.3, .8, 0, -4, 0, HOLD, .015), K(1.06, .95, 0, -6, 0, 'ease-out', .046), K(1, 1, 0, -6, 0, SOFT, .085),
      K(1, 1, -14, -8, 2, SOFT, .27), K(1, 1, 22, -11, 5, TEETER, .5), K(1, 1, 176, -14, 7, SOFT, .8), K(1, 1, 186, -15, 6, SOFT, .9), K(1, 1, 178, -14, 5, SOFT, 1),
    ], 2600, '50% 50%');
    clearInterval(trickle);
    // He bolts still puffed. The air leaks out at half speed as he goes: he shrinks while the jet
    // spins him upright, then the flat fish squashes and stretches into the swim.
    turned = -1; scared = true; ph = 0; v = 0; r = box(); bubbles(1, r.left + 30, r.top + 10, 11, 14, 1.3); go();
    const leak = setInterval(() => { const q = box(); bubbles(1, q.left + 20 + Math.random() * 20, q.top + 12, 4, 7, .9); }, 140);
    setTimeout(() => { clearInterval(fins); clearInterval(leak); fish.classList.remove('puffed'); cel('face', CEL.blink); }, 460);
    await play([K(1, 1, 178, -14, 5, 'ease-in', 0), K(.78, .82, 300, -8, 3, HOLD, .55), K(.8, .72, 318, -10, 2, 'ease-out', .6), K(1.2, .9, 352, -4, 1, 'ease-out', .8), K(1, 1, 360, 0, 0, HOLD, 1)], 840, '50% 50%');
    body.getAnimations().forEach(a => a.cancel()); body.style.transformOrigin = ''; fish.classList.remove('gag');
    for (const f of [CEL.half, 0, CEL.half, CEL.blink, CEL.half, 0]) { cel('face', f); await wait(70); }
    cel('face', CEL.faces.surprised);
  };
}`;

/** Whole document. `script` is page-specific JS that runs after the table helpers and before the fish. */
function page({ title, body, script = '' }) {
  let css = '';
  try { css = fs.readFileSync(path.join(PUFFR_ROOT, 'lib', 'report.css'), 'utf8'); } catch {}
  // PUFFR from abunaico.com, flat and puffed, inlined so the report stays one file.
  // Hovering the heading puffs it up, the same trick as the site's logo.
  let fish = '', icon = '';
  try {
    const uri = f => `data:image/png;base64,${fs.readFileSync(path.join(PUFFR_ROOT, 'assets', f)).toString('base64')}`;
    const flat = uri('puffr-flat.png'), puff = uri('puffr-puff.png');
    icon = `<link rel="icon" href="${flat}">`;
    // The terminal's ANSI fish as tiny pixel PNGs: body, puffed, and a strip of 34px cels.
    const strip = fs.readFileSync(path.join(PUFFR_ROOT, 'assets', 'puffr-cels.png'));
    css += `\n:root{--puffr-body:url(${uri('puffr-body.png')}); --puff-cels:url(${uri('puffr-puff-cels.png')}); --cels:url(${uri('puffr-cels.png')}); --strip:${strip.readUInt32BE(16) * 2}px}\n`;
    fish = `<span class="fishes" aria-hidden="true"><img class="flat" src="${flat}" alt=""><img class="puff" src="${puff}" alt=""></span>`;
  } catch {}
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PUFFR · Fu the Bloat. Cool the Burn.</title>${icon}<style>
${css}</style></head><body>
<h1>${fish || '🐡 '}PUFFR <em>[ ${e(title)} ]</em></h1>
<p class="tagline">Fu the Bloat. Cool the Burn.</p>${body}
<p class="note">Generated ${e(new Date().toISOString().slice(0, 16).replace('T', ' '))} from local Claude Code transcripts. Costs are estimates at Anthropic API list prices. Click a column to sort; type in a filter box to narrow a long table. Indented rows stay with their group.</p>
<button class="totop" type="button" aria-label="Back to top" title="Back to top"><span><i></i></span></button>
<script>
${TABLES_JS}
${script}
${FISH_JS}
</script>
</body></html>
`;
}

module.exports = { e, td, row, table, page };
