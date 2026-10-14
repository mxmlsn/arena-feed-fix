// Окно Connect (выбор каналов), все страницы are.na: прячем СВОЁ имя (и кружок-аватар) справа в строках каналов.
(() => {
  const CFG = {
    myNames: ['maxim'],                      // твоё отображаемое имя; плюс имя, пойманное из ответов сайта
    searchInput: 'input[placeholder^="Type to search"]', // по нему находим окно
  };
  const names = () => {
    const n = new Set(CFG.myNames.map(s => s.trim().toLowerCase()));
    try { const me = JSON.parse(localStorage.getItem('afc-me') || 'null'); if (me && me.name) n.add(me.name.trim().toLowerCase()); } catch (e) {}
    return n;
  };
  // окно = ближайший предок поля поиска, в котором есть ещё и список (много потомков)
  function modalOf(input) {
    let el = input;
    for (let i = 0; i < 6 && el.parentElement; i++) { el = el.parentElement; if (el.querySelectorAll('*').length > 40 || el.matches('[role="dialog"],[aria-modal="true"]')) { if (el.matches('[role="dialog"],[aria-modal="true"]')) return el; } }
    return input.closest('[role="dialog"],[aria-modal="true"]') || el;
  }
  function hideEl(el) { if (el && !el.hasAttribute('data-afc-own')) { el.setAttribute('data-afc-own', '1'); el.style.setProperty('display', 'none', 'important'); } }
  function run() {
    const my = names();
    document.querySelectorAll(CFG.searchInput).forEach(inp => {
      const m = modalOf(inp);
      m.querySelectorAll('*').forEach(el => {
        if (el.childElementCount || el.hasAttribute('data-afc-own') || el.contains(inp)) return;
        const t = (el.textContent || '').replace(/\u00a0/g, ' ').trim().toLowerCase();
        if (!my.has(t)) return;
        hideEl(el);
        // кружок-аватар рядом с именем: соседний маленький элемент без текста
        for (const sib of [el.nextElementSibling, el.previousElementSibling, el.parentElement && el.parentElement.nextElementSibling]) {
          if (sib && !(sib.textContent || '').trim()) { const r = sib.getBoundingClientRect(); if (r.width <= 24 && r.height <= 24) hideEl(sib); }
        }
        // если имя обёрнуто (имя + кружок в своём контейнере), прячем контейнер целиком
        const p = el.parentElement;
        if (p && p.childElementCount <= 2 && (p.textContent || '').trim().toLowerCase() === t && !p.contains(inp)) hideEl(p);
      });
    });
  }
  let raf = 0;
  new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; run(); }); })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
