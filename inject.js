// Are.na Feed Clean v3. Работает в контексте страницы, только на "/" и "/feed".
// Сетку рисует САМ САЙТ: мы перехватываем ответ GraphQL FeedMeQuery и переписываем данные:
//  1) убираем свои группы, 2) убираем повторы блоков (остаётся самый верхний),
//  3) все оставшиеся блоки страницы кладём в первую чужую группу страницы (все её поля без изменений,
//     меняется только objects), остальные группы убираем -> одна большая сетка как на Explore.
// Шапки (автор/время) этих групп прячем в DOM: ищем ссылку на автора, над сеткой с карточками.
(() => {
  const CFG = {
    endpoint: 'https://api.are.na/graphql',
    operation: 'FeedMeQuery',
    paths: ['/', '/feed'],
    maxSkipPages: 15,
    hideMine: true, cleanupMs: 1000, lookupConcurrency: 6,      // прятать чужие сохранения моих блоков и добавления в мои каналы
    columns: 0,          // 0 = как на Explore по ширине окна; число = принудительно (например 4)
    minColWidth: 260, colGap: 15, rowGap: 45, sidePadding: 20, // сетка Explore
    navSelector: 'header, nav',
    restoreMinScroll: 600, restoreMinIndex: 8, saveEveryMs: 1000,
    restoreMaxPages: Infinity, maxQueue: 9, rows1: 10, rows2: 20, restoreWaitMs: 6000,
    timeRegex: /\b(ago|just now|yesterday)\b/i,               // сколько страниц подряд без новых блоков подтягиваем сами
    debug: true,
  };
  const log = (...a) => CFG.debug && console.log('[arena-feed-clean]', ...a);
  const warn = (...a) => console.warn('[arena-feed-clean]', ...a);
  const onPath = () => CFG.paths.includes(location.pathname.replace(/\/+$/, '') || '/');

  // ---------- колонки как на Explore ----------
  // Explore: grid auto-fill, minmax(260px, 1fr), gap 15px. Считаем от ширины окна (в CSS px, т.е. с учётом зума).
  function columns() {
    if (CFG.columns) return CFG.columns;
    const w = document.documentElement.clientWidth - 2 * CFG.sidePadding;
    return Math.max(1, Math.floor((w + CFG.colGap) / (CFG.minColWidth + CFG.colGap)));
  }

  // ---------- данные ----------
  const pages = new Map();  // offset -> Set ключей блоков, отданных под этим offset
  const carry = new Map();  // offset -> блоки-остаток (не влезли в полный ряд), отдать в начале этой страницы
  let lastHost = null, lastOffset = 0;
  const meta = new Map(); // id блока -> {img, title, date}
  const order = new Map(); // id блока -> порядковый номер в ленте (для «самого дальнего» места)
  const keyOf = o => (o.__typename === 'Channel' ? 'ch:' : 'b:') + o.id;
  const isOwn = (g, meId) => {
    const a = g.actor || g.owner || {};
    return a.__typename !== 'Group' && meId != null && String(a.id) === String(meId);
  };
  const seenBefore = off => { const s = new Set(); for (const [o, k] of pages) if (o < off) k.forEach(x => s.add(x)); return s; };

  // ---------- чужие сохранения МОИХ блоков / каналов ----------
  // В ответе ленты у блоков нет владельца, поэтому догружаем его одним запросом на страницу:
  // block(id) { ... on Block { user { id } } }. Свой href (/slug) берём из me { href }.
  const owners = new Map(); // id блока -> id владельца
  let myHref = null, myId = null;
  const diag = (...a) => console.log('[arena-feed-fix]', ...a);
  const isMine = (o, meId) => {
    if (!CFG.hideMine || meId == null) return false;
    if (o.__typename === 'Channel') { const ow = o.owner || o.user; return !!(ow && ow.__typename !== 'Group' && String(ow.id) === String(meId)) || !!(myHref && o.href && o.href.startsWith(myHref + '/')); }
    if (!owners.has(String(o.id))) return false;   // ещё неизвестен: показываем, проверим в фоне
    const u = owners.get(String(o.id));
    if (!u) return false;
    if (String(u.id) === String(meId)) { if (!myHref && u.slug) myHref = '/' + u.slug; return true; }
    return !!myHref && !!u.slug && '/' + u.slug === myHref;
  };
  const isMyTarget = g => {
    if (!CFG.hideMine || !myHref) return false;
    const t = g.target;
    return !!(t && t.href && t.href.startsWith(myHref + '/'));
  };
  // Владелец блока: публичный REST https://api.are.na/v2/blocks/<id> (проверено: отдаёт user {id, slug}).
  // Простой GET без cookies и заголовков (CORS allow-origin *). Кэш по id.
  // -> {id, slug} | null (блок недоступен публично: приватный/удалён) | undefined (ошибка сети/лимит, не кэшируем)
  const inflight = new Map(); let hideUnknown = true, lookupPausedUntil = 0;
  function lookupOnce(id) { if (!inflight.has(id)) inflight.set(id, ownerOf(id).finally(() => setTimeout(() => inflight.delete(id), 0))); return inflight.get(id); }
  async function ownerOf(id) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ac = new AbortController(); const tt = setTimeout(() => ac.abort(), 3000);
        const res = await origFetch('https://api.are.na/v2/blocks/' + id, { credentials: 'omit', signal: ac.signal }).finally(() => clearTimeout(tt));
        if (res.ok) { const j = await res.json(); return j && j.user ? { id: j.user.id, slug: j.user.slug } : null; }
        if (res.status !== 429 && res.status < 500) return null; // 401/403/404: приватный или удалён
        diag('owner lookup HTTP ' + res.status + ' for block ' + id + (attempt ? ', giving up' : ', retrying'));
      } catch (e) { diag('owner lookup failed for block ' + id + (attempt ? ', giving up' : ', retrying'), String(e)); }
      await new Promise(r => setTimeout(r, 800));
    }
    return undefined;
  }
  // Фоновый поиск владельцев: ответ ленты НЕ ждёт. Что найдено, сохраняется в localStorage,
  // а уже показанные карточки моих блоков убираются из DOM.
  const OWN_KEY = 'afc-owners-v1', ME_KEY = 'afc-me-v1';
  try { const o = JSON.parse(localStorage.getItem(OWN_KEY) || '{}'); for (const k in o) owners.set(k, o[k] ? { id: o[k] } : null); } catch (e) {}
  try { const m = JSON.parse(localStorage.getItem(ME_KEY) || 'null'); if (m) { myId = m.id; myHref = myHref || m.href || null; } } catch (e) {}
  let persistT = 0;
  function persistOwners() {
    clearTimeout(persistT);
    persistT = setTimeout(() => {
      const o = {}; let n = 0;
      for (const [k, v] of [...owners].reverse()) { if (n++ > 30000) break; o[k] = v ? v.id : 0; } // последние 30k
      try { localStorage.setItem(OWN_KEY, JSON.stringify(o)); localStorage.setItem(ME_KEY, JSON.stringify({ id: myId, href: myHref })); } catch (e) {}
    }, 1000);
  }
  const queue = []; let running = 0;
  function lookupInBackground(req, groups) {
    if (!CFG.hideMine) return;
    if (!myHref && !lookupInBackground.me) {
      lookupInBackground.me = true;
      Promise.race([postJson(req, { operationName: 'AfcMe', query: 'query AfcMe { me { id href } }', variables: {} }), new Promise(r => setTimeout(() => r(null), 3000))])
        .then(j => { if (j && j.data && j.data.me && j.data.me.href) { myHref = j.data.me.href.replace(/\/+$/, ''); persistOwners(); } }).catch(() => {});
    }
    for (const g of groups) for (const o of g.objects || []) {
      const id = o && String(o.id);
      if (!o || ['Channel', 'User', 'Group'].includes(o.__typename) || !/^\d+$/.test(id) || owners.has(id) || queue.includes(id) || inflight.has(id)) continue;
      queue.push(id);
    }
    pump();
  }
  function pump() {
    if (Date.now() < lookupPausedUntil) { setTimeout(pump, lookupPausedUntil - Date.now() + 50); return; }
    while (running < CFG.lookupConcurrency && queue.length) {
      const id = queue.shift(); running++;
      lookupOnce(id).then(o => {
        if (o !== undefined) { owners.set(id, o); persistOwners(); if (o && String(o.id) === String(myId)) { if (!myHref && o.slug) myHref = '/' + o.slug; diag('Image ' + id + ' is mine, removing card'); hideMineCards(); } }
        else { failStreak++; if (failStreak >= 4) { lookupPausedUntil = Date.now() + 60000; failStreak = 0; diag('owners lookup: repeated failures, pausing 60s'); } }
        if (o !== undefined) failStreak = 0;
      }).finally(() => { running--; pump(); });
    }
  }
  let failStreak = 0;
  async function waitKnown(groups, deadline) {
    if (!CFG.hideMine) return;
    const ids = [];
    for (const g of groups) for (const o of g.objects || []) if (o && !['Channel', 'User', 'Group'].includes(o.__typename)) ids.push(String(o.id));
    while (Date.now() < deadline && Date.now() >= lookupPausedUntil && ids.some(id => !owners.has(id))) await new Promise(r => setTimeout(r, 40));
  }

  // Убираем из DOM карточки блоков, которые оказались моими (в т.ч. после перерисовки списка).
  function hideMineCards() {
    if (!CFG.hideMine || myId == null) return;
    document.querySelectorAll('.afc-grid a[href*="/block/"]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/\/block\/(\d+)/); if (!m) return;
      const u = owners.get(m[1]); if (!u || String(u.id) !== String(myId)) return;
      let cell = a; while (cell.parentElement && !cell.parentElement.classList.contains('afc-grid')) cell = cell.parentElement;
      if (cell.parentElement && !cell.hasAttribute('data-afc-mine')) { cell.setAttribute('data-afc-mine', '1'); cell.style.setProperty('display', 'none', 'important'); }
    });
  }

  // Отбирает новые блоки из групп одной сырой страницы. Возвращает {objects, host}.
  function pickBlocks(me, groups, seen, kept) {
    const objects = []; let host = null;
    for (const g of groups) {
      if (isOwn(g, me.id)) { diag('item hidden: my own save', g.id); continue; }
      if (isMyTarget(g)) { diag('item hidden: added to my channel', g.target && g.target.href); continue; }           // кто-то добавил что-то в МОЙ канал
      if (!host) host = g;
      for (const o of g.objects || []) {
        if (!o) continue;
        { const mine = isMine(o, me.id), ow = o.__typename === 'Channel' ? (o.owner || o.user) : owners.get(String(o.id));
          diag(o.__typename, o.id, 'by actor', (g.actor || g.owner || {}).slug || (g.actor || g.owner || {}).id, 'owner', ow ? (ow.slug || ow.name || ow.id) : 'unknown', mine ? (o.__typename !== 'Channel' && !owners.has(String(o.id)) ? 'HIDDEN (owner lookup failed)' : 'HIDDEN (mine)') : 'shown');
          if (mine) continue; }
        const k = keyOf(o);
        if (seen.has(k)) continue;
        seen.add(k); kept.add(k); objects.push(o);
        if (o.__typename !== 'Channel') { const ri = o.resized_image && o.resized_image.grid_cell_resized_image;
          meta.set(String(o.id), { img: ri && ri.src_1x || '', title: o.title || (o.truncatedContent || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 80), date: g.created_at_timestamp || g.created_at || '' }); }
      }
    }
    return { objects, host };
  }
  // шапки контейнеров: href автора -> число блоков в сетке
  const headerHrefs = new Map();
  function markHeader(g, n) {
    const a = g.actor || g.owner || {};
    if (a.href) headerHrefs.set(a.href, n);
  }

  // ---------- перехват fetch ----------
  const origFetch = window.fetch.bind(window);
  const plainHeaders = h => { const o = {}; try { new Headers(h || {}).forEach((v, k) => { o[k] = v; }); } catch (e) {} return o; };

  async function readReq(input, init) {
    // -> {url, method, headers, bodyText} или null
    if (input instanceof Request) {
      if (!input.url.startsWith(CFG.endpoint)) return null;
      const c = input.clone();
      const bodyText = init && typeof init.body === 'string' ? init.body : await c.text();
      return { url: c.url, method: (init && init.method) || c.method, headers: Object.assign(plainHeaders(c.headers), plainHeaders(init && init.headers)), bodyText };
    }
    const url = String(input && input.url || input);
    if (!url.startsWith(CFG.endpoint)) return null;
    return { url, method: (init && init.method) || 'POST', headers: plainHeaders(init && init.headers), bodyText: init && init.body };
  }

  async function postJson(req, body) {
    // свежий запрос: без signal сайта, без cookies (у API allow-origin *)
    const res = await origFetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(body), credentials: 'omit' });
    return res.json();
  }
  const groupsOf = j => (j && j.data && j.data.me && j.data.me.feed && j.data.me.feed.groups) || null;

  // Одна страница сайта -> одна группа (настоящая чужая группа, меняется только objects),
  // в которой число блоков кратно числу колонок. Остаток переносится на следующую страницу.
  async function transform(json, req, body) {
    const vars = body.variables || {};
    const off0 = Number(vars.offset) || 0, limit = Number(vars.limit) || 12;
    if (!groupsOf(json)) return json;          // не та форма, отдаём как есть
    const deadline = Date.now() + CFG.cleanupMs;
    if (off0 === 0) { pages.clear(); carry.clear(); order.clear(); }
    lastOffset = off0;
    const cols = columns();
    const seen = seenBefore(off0), kept = new Set();
    let acc = (carry.get(off0) || []).slice(), host = null, cur = json, end = false;
    for (let i = 0; ; i++) {
      const raw = groupsOf(cur);
      if (!raw) { end = true; break; }
      if (raw.length === 0) { end = true; break; } // настоящий конец ленты
      if (cur.data.me && cur.data.me.id != null && String(myId) !== String(cur.data.me.id)) { myId = cur.data.me.id; persistOwners(); }
      lookupInBackground(req, raw);
      await waitKnown(raw, deadline);  // ждём не дольше общего окна CFG.cleanupMs на страницу
      const r = pickBlocks(cur.data.me, raw, seen, kept);
      if (r.host) host = r.host;
      if (!host && !lastHost) lastHost = raw[0];
      acc.push(...r.objects);
      if (acc.length >= cols || i >= CFG.maxSkipPages) break;
      const nb = JSON.parse(JSON.stringify(body));
      nb.variables = Object.assign({}, nb.variables, { offset: off0 + (i + 1) * limit });
      cur = await postJson(req, nb);
    }
    pages.set(off0, kept);
    host = host || lastHost;
    if (host) lastHost = host;
    let objects = acc;
    if (!end) { const n = Math.floor(acc.length / cols) * cols; objects = acc.slice(0, n); carry.set(off0 + limit, acc.slice(n)); }
    else carry.delete(off0 + limit);
    for (const o of objects) if (o.__typename !== 'Channel' && !order.has(String(o.id))) order.set(String(o.id), order.size + 1);
    const me = json.data.me;
    if (!objects.length || !host) { me.feed.groups = end && !objects.length ? [] : (host ? [Object.assign({}, host, { objects })] : []); }
    else { markHeader(host, objects.length); me.feed.groups = [Object.assign({}, host, { objects })]; }
    log('page', off0, 'cols', cols, '->', objects.length, 'blocks', end ? '(end)' : 'carry ' + (acc.length - objects.length));
    return json;
  }

  function sniffMe(input, res) {
    try {
      const url = String(input && input.url || input);
      if (!url.startsWith(CFG.endpoint)) return;
      res.clone().json().then(j => {
        const me = j && j.data && j.data.me;
        if (me && me.name) localStorage.setItem('afc-me', JSON.stringify({ name: me.name, slug: me.slug || '' }));
      }).catch(() => {});
    } catch (e) {}
  }
  window.fetch = async function (input, init) {
    let req = null, body = null;
    try {
      if (onPath() && !(init && init.__afc)) {
        req = await readReq(input, init);
        if (req && typeof req.bodyText === 'string' && req.bodyText.includes(CFG.operation)) body = JSON.parse(req.bodyText);
      }
    } catch (e) { warn('read request', e); }
    const res = await origFetch(input, init);
    sniffMe(input, res);
    if (!body) return res;
    try {
      const json = await transform(await res.clone().json(), req, body);
      const headers = new Headers(res.headers); headers.delete('content-length'); headers.delete('content-encoding');
      return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e; // сайт сам отменил, как и без нас
      warn('transform failed, отдаю как есть', e);
      return res;
    }
  };

  // ---------- DOM: прячем шапки склеенных групп и их отступы ----------
  const HID = 'data-afc-hidden';
  function hide(el) { if (el && !el.hasAttribute(HID)) { el.setAttribute(HID, el.style.display || ''); el.style.display = 'none'; } }
  function unhideAll() { document.querySelectorAll('[' + HID + ']').forEach(el => { el.style.display = el.getAttribute(HID); el.removeAttribute(HID); }); }
  const GRID = 'afc-grid', WRAP = 'afc-group';
  // всё, что во всплывающих окнах (уведомления, меню, диалоги), не трогаем
  const POPUP = '[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"],[aria-modal="true"],[data-radix-popper-content-wrapper],[data-side]';
  const inPopup = el => !!(el && el.closest && el.closest(POPUP));
  const feedList = () => document.querySelector('[data-testid="virtuoso-item-list"], [data-test-id="virtuoso-item-list"]');
  const inFeed = el => { if (inPopup(el)) return false; const l = feedList(); return l ? l.contains(el) : true; };
  function fixHeaders() {
    if (headerHrefs.size) {
      const sel = [...headerHrefs.keys()].map(h => 'a[href="' + CSS.escape(h) + '"]:not([data-afc-done])').join(',');
      document.querySelectorAll(sel).forEach(a => {
        if (a.closest('.' + GRID) || !inFeed(a)) return; // ссылка внутри карточки или вне ленты
        const n = headerHrefs.get(a.getAttribute('href')) || 1;
        // поднимаемся до обёртки группы: её последний ребёнок это сетка с карточками
        let el = a;
        for (let i = 0; i < 8 && el.parentElement; i++, el = el.parentElement) {
          const p = el.parentElement, last = p.lastElementChild;
          if (!last || last === el || last.contains(a) || p.childElementCount < 2) continue;
          const isGrid = last.childElementCount >= Math.min(n, 2) && (last.querySelector('img, a[href*="/block/"]') || last.childElementCount >= n);
          if (!isGrid) continue;
          a.setAttribute('data-afc-done', '1');
          for (const c of [...p.children]) if (c !== last) hide(c); // шапка, время, отступ
          last.classList.add(GRID); p.classList.add(WRAP); touched.add(last); touched.add(p);
          const prev = p.previousElementSibling; // разделитель между группами
          if (prev && !prev.querySelector('img, a') && prev.getBoundingClientRect().height < 60) hide(prev);
          return;
        }
      });
    }
    // запасной путь: строки времени ("about 1 hour ago") вне карточек
    document.querySelectorAll('span:not([data-afc-t])').forEach(sp => {
      sp.setAttribute('data-afc-t', '1');
      if (sp.childElementCount || !CFG.timeRegex.test(sp.textContent || '') || sp.closest('.' + GRID + ', a') || !inFeed(sp)) return;
      hide(sp.parentElement && sp.parentElement.childElementCount === 1 ? sp.parentElement : sp);
    });
    hideMineCards();
    document.documentElement.style.setProperty('--afc-cols', columns());
  }
  const touched = new Set();
  function unmarkAll() {
    unhideAll();
    touched.forEach(el => el.classList.remove(GRID, WRAP)); touched.clear();
    document.querySelectorAll('[data-afc-done],[data-afc-t]').forEach(e => { e.removeAttribute('data-afc-done'); e.removeAttribute('data-afc-t'); });
  }

  let raf = 0, was = null;
  function sync() {
    const on = onPath();
    document.documentElement.classList.toggle('afc-home', on);
    if (on) fixHeaders(); else if (was) unmarkAll();
    was = on;
  }
  new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync(); }); })
    .observe(document, { childList: true, subtree: true });
  setInterval(sync, 500);

  // ---------- навигация и память места (левый нижний угол) ----------
  const posKey = () => 'afc-feed-pos:' + (location.pathname.replace(/\/+$/, '') || '/');
  const AUTO_KEY = 'afc-auto-save';
  const blockIdOf = a => { const m = (a.getAttribute('href') || '').match(/\/block\/(\d+)/); return m && m[1]; };
  const cards = () => [...document.querySelectorAll('.' + GRID + ' > :not([data-afc-mine]) a[href*="/block/"], .' + GRID + ' > a:not([data-afc-mine])[href*="/block/"]')];
  const findCard = id => cards().find(a => blockIdOf(a) === String(id));
  const ls = { get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
               set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }, del(k) { try { localStorage.removeItem(k); } catch (e) {} } };
  const autoOn = () => ls.get(AUTO_KEY) !== false;
  let restoring = false, saveTimer = 0, ui = null;
  const navBottom = () => { const n = document.querySelector(CFG.navSelector); return n ? Math.max(0, n.getBoundingClientRect().bottom) : 0; };
  const seqOf = id => order.get(String(id)) || 0;

  function visibleCards() { const nb = navBottom(); return cards().filter(a => { const r = a.getBoundingClientRect(); return r.bottom > nb + 10 && r.top < innerHeight; }); }
  function savePos(manual) {
    if (!onPath() || restoring) return;
    const vis = visibleCards(); if (!vis.length) return;
    if (manual) { const a = vis[0]; const id = blockIdOf(a); ls.set(posKey(), Object.assign({ id, seq: seqOf(id), pinned: true, t: Date.now() }, meta.get(id) || {})); flash('Position pinned'); return; }
    if (!autoOn()) return;
    const cur = ls.get(posKey());
    if (cur && cur.pinned) return;
    let best = null, bs = -1;
    for (const a of vis) { const s = seqOf(blockIdOf(a)); if (s > bs) { bs = s; best = a; } }
    // Сравниваем только порядком ТЕКУЩЕЙ загрузки ленты: номера после перезагрузки начинаются заново.
    // Если сохранённый блок в этой сессии ещё не встречался, его позиция неизвестна -> не перезаписываем.
    const savedNow = cur && cur.id ? seqOf(cur.id) : 0;
    if (best && (!cur || !cur.id || (savedNow && bs > savedNow))) { const id = blockIdOf(best); ls.set(posKey(), Object.assign({ id, seq: bs, t: Date.now() }, meta.get(id) || {})); }
  }
  addEventListener('scroll', () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => savePos(false), 700); }, { passive: true });

  function rowHeight() { const c = document.querySelector('.' + GRID + ' > :not([data-afc-mine]):not([data-afc-hidden])'); return c ? c.getBoundingClientRect().height + CFG.rowGap : 400; }
  function prog(btn, p) { if (!btn) return; if (p == null) { btn.classList.remove('afc-prog', 'afc-busy'); btn.style.removeProperty('--p'); return; }
    if (p < 0) { btn.classList.add('afc-busy'); return; } btn.classList.remove('afc-busy'); btn.classList.add('afc-prog'); btn.style.setProperty('--p', Math.min(1, p)); }
  // очередь: клики во время прокрутки добавляют ещё циклы (точки внутри кнопки)
  let scrollCancel = false;
  function dots(btn) {
    let d = btn.querySelector('.afc-dots');
    if (!d) { d = document.createElement('span'); d.className = 'afc-dots'; btn.appendChild(d); }
    const q = btn._q || 0;
    d.textContent = q ? '•'.repeat(Math.min(q, 5)) + (q > 5 ? '+' : '') : '';
  }
  function clearQueues() { scrollCancel = true; if (ui) ui.box.querySelectorAll('button').forEach(b => { b._q = 0; dots(b); }); }
  async function queueRows(n, btn) {
    if (btn._busy) { btn._q = Math.min((btn._q || 0) + 1, CFG.maxQueue); dots(btn); return; }
    btn._busy = true; scrollCancel = false;
    try {
      do {
        if (btn._q > 0 && btn._started) { btn._q--; dots(btn); }
        btn._started = true;
        await scrollRows(n, btn);
      } while (!scrollCancel && btn._q > 0);
    } finally { btn._busy = false; btn._started = false; btn._q = 0; dots(btn); }
  }
  async function scrollRows(n, btn) {
    const start = window.scrollY, target = start + n * rowHeight();
    const tick = () => prog(btn, (window.scrollY - start) / (target - start));
    addEventListener('scroll', tick, { passive: true });
    try { await scrollLoop(target); } finally { removeEventListener('scroll', tick); prog(btn, null); }
  }
  async function scrollLoop(target) {
    for (let i = 0; i < 25 && !scrollCancel && window.scrollY < target - 5; i++) {
      window.scrollTo({ top: target, behavior: i ? 'auto' : 'smooth' });
      await new Promise(r => setTimeout(r, 400)); // если ряды ещё не подгружены, сайт догрузит
    }
  }
  async function goTo() {
    const saved = ls.get(posKey());
    if (!saved || !saved.id) { flash('No saved position'); return; }
    restoring = true; const pt = setInterval(() => ui && prog(ui.pin, saved.seq ? order.size / saved.seq : -1), 200);
    try {
      for (let page = 0; restoring && page <= CFG.restoreMaxPages; page++) {
        const el = findCard(saved.id);
        if (el) {
          el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -navBottom() - 20);
          // ручная метка одноразовая: после успешного перехода снова работает автозапоминание с этой точки
          if (saved.pinned) { const sv = Object.assign({}, saved); delete sv.pinned; ls.set(posKey(), sv); }
          return;
        }
        const before = cards().length, h0 = document.documentElement.scrollHeight, t0 = Date.now();
        window.scrollTo(0, h0);
        while (restoring && Date.now() - t0 < CFG.restoreWaitMs) {
          await new Promise(r => setTimeout(r, 200));
          if (cards().length !== before || document.documentElement.scrollHeight > h0 + 50 || findCard(saved.id)) break;
          window.scrollTo(0, document.documentElement.scrollHeight);
        }
        if (restoring && Date.now() - t0 >= CFG.restoreWaitMs && !findCard(saved.id)) { flash('Not found: reached the end of the feed'); return; }
      }
      if (restoring && isFinite(CFG.restoreMaxPages)) flash('Not found within ' + CFG.restoreMaxPages + ' loads');
    } finally { restoring = false; clearInterval(pt); ui && prog(ui.pin, null); }
  }

  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ICON = {
    down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
    down2: '<svg viewBox="0 0 24 24"><path d="M6 5l6 6 6-6M6 12l6 6 6-6"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  };
  function flash(t) { if (!ui) return; ui.tip.textContent = t; ui.tip.style.display = 'block'; clearTimeout(ui.tt); ui.tt = setTimeout(() => { ui.tip.style.display = 'none'; }, 2500); }
  function closeMenu() { if (ui && ui.menu) { ui.menu.remove(); ui.menu = null; } }
  function openMenu(x, y) {
    closeMenu();
    const m = document.createElement('div'); m.className = 'afc-menu';
    const items = [
      ['Pin current position', () => savePos(true)],
      ['Auto-save: ' + (autoOn() ? 'on' : 'off'), () => { ls.set(AUTO_KEY, !autoOn()); flash('Auto-save ' + (autoOn() ? 'on' : 'off')); }],
      [(ls.get('afc-hide-name') !== false ? '☑' : '☐') + ' Hide your name', () => { const on = ls.get('afc-hide-name') === false; ls.set('afc-hide-name', on); flash('Hide your name: ' + (on ? 'on' : 'off')); }],
      ['Reset memory', () => { clearQueues(); ls.del(posKey()); flash('Memory reset'); }],
    ];

    for (const [t, f] of items) { const b = document.createElement('button'); b.textContent = t; b.onclick = () => { closeMenu(); f(); }; m.appendChild(b); }
    const help = document.createElement('div'); help.className = 'afc-help';
    help.textContent = 'Click an arrow again to queue more runs (dots = queued). Right-click a running arrow to stop and clear the queue. The pin jumps to your furthest point; a manual pin is used once.';
    m.appendChild(help);
    document.body.appendChild(m);
    m.style.left = x + 'px'; m.style.top = Math.max(8, y - m.offsetHeight) + 'px';
    ui.menu = m;
  }
  function makeUi() {
    const box = document.createElement('div'); box.id = 'afc-nav';
    box.innerHTML = `<button data-k="d1" title="Scroll down ${CFG.rows1} rows">${ICON.down}</button><button data-k="d2" title="Scroll down ${CFG.rows2} rows">${ICON.down2}</button><button data-k="pin">${ICON.pin}</button><div class="afc-tip"></div>`;
    document.body.appendChild(box);
    ui = { box, pin: box.querySelector('[data-k=pin]'), tip: box.querySelector('.afc-tip'), menu: null };
    const d1 = box.querySelector('[data-k=d1]'), d2 = box.querySelector('[data-k=d2]');
    d1.onclick = () => queueRows(CFG.rows1, d1);
    d2.onclick = () => queueRows(CFG.rows2, d2);
    ui.pin.onclick = () => { clearQueues(); if (restoring) restoring = false; else goTo(); };
    ui.pin.addEventListener('mouseenter', () => {
      const sv = ls.get(posKey());
      if (!sv || !sv.id) { ui.tip.textContent = 'No saved position'; }
      else {
        const vis = visibleCards(); const cur = vis.length ? Math.max(...vis.map(a => seqOf(blockIdOf(a)))) : 0;
        const tseq = seqOf(sv.id) || sv.seq; const rows = tseq && cur ? Math.round((tseq - cur) / columns()) : null;
        const dist = rows == null ? 'Go to saved position' : rows > 0 ? 'About ' + rows + ' rows down' : rows < 0 ? 'About ' + (-rows) + ' rows up' : 'You are here';
        ui.tip.innerHTML = (sv.img ? '<img src="' + esc(sv.img) + '">' : sv.title ? '<div class="afc-tt">' + esc(sv.title) + '</div>' : '')
          + '<div>' + esc(dist) + '</div>' + (sv.date ? '<div class="afc-td">' + esc(sv.date) + '</div>' : '') + (restoring ? '<div class="afc-td">Click to cancel</div>' : '');
      }
      ui.tip.style.display = 'block';
    });
    ui.pin.addEventListener('mouseleave', () => { ui.tip.style.display = 'none'; });
    box.addEventListener('contextmenu', e => { if (e.target.closest('button') && e.target.closest('button')._busy) { e.preventDefault(); clearQueues(); return; } e.preventDefault(); openMenu(e.clientX, e.clientY); });
  }
  addEventListener('mousedown', e => { if (ui && ui.menu && !ui.menu.contains(e.target)) closeMenu(); }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  setInterval(() => {
    if (!onPath()) { if (ui) { closeMenu(); ui.box.remove(); ui = null; restoring = false; } return; }
    if (!ui && document.body) makeUi();
  }, 500);

  window.__arenaFeedClean = { savePos, goTo, findCard, CFG, transform, pages, carry };
})();
