(function () {
  const MAX_PEOPLE = 10;
  const MAX_LEN = 100;
  const QUICK = ['매운 음식', '해산물', '오이', '고수', '날것', '내장', '물에 빠진 고기'];
  const COUNT = { list: 3, random: 5 }; // 랜덤은 후보를 더 받아서 룰렛이 덜 심심하게
  const MAX_SEEN = 15;
  // 쉼표 말고도 사람들이 자주 쓰는 구분자까지 인식
  const SPLIT = /[,，、\/·]+/;
  const SEEN_KEY = 'menu-picker:seen';

  // 최근 추천 기록은 이 브라우저에만 저장 (저장이 막혀 있어도 동작은 그대로)
  function loadSeen() {
    try {
      const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
      return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(-MAX_SEEN) : [];
    } catch { return []; }
  }
  function saveSeen(list) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(list)); } catch { /* 무시 */ }
  }

  const state = {
    people: ['', ''],
    meal: '저녁',
    alcohol: false,
    lastFocus: 0,
    loading: false,
    optsOpen: false,
    error: null,
    menus: [],
    seen: loadSeen() // 최근에 본 메뉴는 다시 안 나오게 (새로고침해도 유지)
  };

  const card = document.getElementById('card');
  const randomBtn = document.getElementById('randomBtn');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function mascot() { return document.getElementById('mascotTpl').content.cloneNode(true); }
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const k in (attrs || {})) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'class') node.className = attrs[k];
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(c => c && node.append(c));
    return node;
  }

  // 입력 문자열을 항목 배열로 (중복 제거)
  function items(text) {
    return [...new Set(text.split(SPLIT).map(s => s.trim()).filter(Boolean))];
  }

  function payload() {
    return {
      people: state.people
        .map((t, i) => ({ id: i + 1, dislikes: items(t).join(', ') }))
        .filter(p => p.dislikes),
      options: { meal: state.meal, alcohol: state.alcohol }
    };
  }

  /* ---------- API 호출 ---------- */
  async function fetchMenus(mode, exclude) {
    let res;
    try {
      res = await fetch('/api/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload(), count: COUNT[mode], exclude })
      });
    } catch {
      throw new Error('인터넷 연결을 확인하고 다시 시도해주세요');
    }
    let data = {};
    try { data = await res.json(); } catch { /* 빈 응답 */ }
    if (!res.ok) throw new Error(data.error || '메뉴 추천에 실패했어요. 잠시 후 다시 시도해주세요');
    if (!Array.isArray(data.menus) || data.menus.length === 0) {
      throw new Error('조건에 맞는 메뉴를 찾지 못했어요. 싫어하는 음식을 조금 줄여보세요');
    }
    return data.menus;
  }

  // mode: 'list'(추천 3개) | 'random'(룰렛)
  // button이 있으면 그 버튼만 로딩 표시, 없으면 입력 화면 전체를 로딩 상태로
  // 어느 경우든 최근에 본 메뉴는 제외하고 요청
  async function run(mode, button) {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    randomBtn.disabled = true;
    if (button) { button.disabled = true; button.textContent = '고르는 중…'; }
    else renderForm();

    try {
      state.menus = await fetchMenus(mode, state.seen);
      state.seen = [...new Set([...state.seen, ...state.menus.map(m => m.name)])].slice(-MAX_SEEN);
      saveSeen(state.seen);
      state.loading = false;
      randomBtn.disabled = false;
      mode === 'random' ? renderRandom() : renderResults();
    } catch (e) {
      state.loading = false;
      randomBtn.disabled = false;
      state.error = e.message;
      renderForm();
    }
  }

  /* ---------- 입력 화면 ---------- */
  function renderForm(focusIndex) {
    card.innerHTML = '';
    const hero = el('div', { class: 'hero' });
    hero.append(mascot());
    hero.append(el('h1', { text: '싫어하는 음식만 적어주세요' }));
    hero.append(el('p', { text: '모두 먹을 수 있는 메뉴를 골라드릴게요' }));
    card.append(hero);

    const list = el('ol', { class: 'rows' });
    state.people.forEach((value, i) => {
      const input = el('input', {
        type: 'text',
        maxlength: String(MAX_LEN),
        placeholder: '싫어하는 음식을 입력해주세요',
        'aria-label': (i + 1) + '번 사람이 싫어하는 음식',
        oninput: e => { state.people[i] = e.target.value; refreshChips(); },
        onfocus: () => {
          if (state.lastFocus === i) return;
          state.lastFocus = i;
          refreshChips();
        },
        // 한글 조합 중 Enter는 무시 (조합 중에 이벤트가 두 번 발생하는 문제 방지)
        onkeydown: e => {
          if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          run('list');
        }
      });
      input.value = value;
      if (state.loading) input.disabled = true;
      const row = el('li', { class: 'row' }, [el('span', { class: 'num', text: (i + 1) + '.' }), input]);
      if (state.people.length > 2 && !state.loading) {
        row.append(el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': (i + 1) + '번 삭제', text: '×',
          onclick: () => {
            state.people.splice(i, 1);
            state.lastFocus = Math.min(state.lastFocus, state.people.length - 1);
            renderForm();
          }
        }));
      }
      list.append(row);
    });
    card.append(list);

    // 칩은 마지막으로 선택한 사람 기준으로 켜짐/꺼짐 표시, 다시 누르면 빠짐
    const target = state.lastFocus;
    const current = items(state.people[target]);
    const quick = el('div', { class: 'quick' }, [el('span', { text: (target + 1) + '번에 추가' })]);
    QUICK.forEach(q => quick.append(el('button', {
      class: 'chip', type: 'button', text: q,
      'aria-pressed': String(current.includes(q)),
      onclick: () => {
        if (state.loading) return;
        const i = state.lastFocus;
        const list = items(state.people[i]);
        const idx = list.indexOf(q);
        if (idx >= 0) list.splice(idx, 1);
        else list.push(q);
        const next = list.join(', ');
        if (next.length <= MAX_LEN) state.people[i] = next;
        renderForm(i);
      }
    })));
    card.append(quick);

    const full = state.people.length >= MAX_PEOPLE;
    const addBtn = el('button', {
      class: 'add', type: 'button',
      onclick: () => {
        if (state.people.length >= MAX_PEOPLE || state.loading) return;
        state.people.push('');
        state.lastFocus = state.people.length - 1;
        renderForm(state.lastFocus);
      }
    });
    if (full || state.loading) addBtn.disabled = true;
    addBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="4" fill="currentColor"/><path d="M1.5 20c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5z" fill="currentColor"/><path d="M19 7v6M16 10h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    addBtn.append(document.createTextNode(full ? '최대 ' + MAX_PEOPLE + '명까지 추가할 수 있어요' : '친구 추가하기'));
    card.append(addBtn);

    const opts = el('details', { class: 'opts' }, [el('summary', { text: '식사 옵션' })]);
    const grid = el('div', { class: 'opt-grid' });
    grid.append(segment('식사 시간', ['점심', '저녁'], state.meal, v => { state.meal = v; }));
    grid.append(segment('술', ['안 마셔요', '마실 거예요'], state.alcohol ? '마실 거예요' : '안 마셔요', v => { state.alcohol = v === '마실 거예요'; }));
    opts.append(grid);
    opts.open = state.optsOpen;
    opts.addEventListener('toggle', () => { state.optsOpen = opts.open; });
    card.append(opts);

    if (state.error) card.append(el('p', { class: 'error', role: 'alert', text: state.error }));

    const go = el('button', {
      class: 'primary', type: 'button',
      text: state.loading ? '메뉴 고르는 중…' : '메뉴 추천받기',
      onclick: () => run('list')
    });
    if (state.loading) go.disabled = true;
    card.append(go);
    card.append(el('p', { class: 'note', text: 'HyperCLOVA X가 추천해요. 알레르기가 있다면 식당에서 재료를 꼭 확인해주세요.' }));

    if (typeof focusIndex === 'number') {
      const target = card.querySelectorAll('.row input')[focusIndex];
      if (target) { target.focus(); target.setSelectionRange(target.value.length, target.value.length); }
    }
  }

  // 입력 화면 전체를 다시 그리지 않고 칩 상태만 갱신 (입력 중 포커스 유지)
  function refreshChips() {
    const quick = card.querySelector('.quick');
    if (!quick) return;
    const current = items(state.people[state.lastFocus] || '');
    quick.querySelector('span').textContent = (state.lastFocus + 1) + '번에 추가';
    quick.querySelectorAll('.chip').forEach(b => {
      b.setAttribute('aria-pressed', String(current.includes(b.textContent)));
    });
  }

  function segment(label, options, current, onPick) {
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': label });
    options.forEach(o => {
      const b = el('button', {
        type: 'button', text: o, 'aria-pressed': String(o === current),
        onclick: () => {
          onPick(o);
          seg.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        }
      });
      seg.append(b);
    });
    return el('div', { class: 'opt' }, [el('span', { text: label }), seg]);
  }

  // 사용자가 입력한 조건으로 칩 생성 (모델 응답에 의존하지 않음)
  function conditionChips() {
    const wrap = el('div', { class: 'avoid' });
    payload().people.forEach(p => {
      items(p.dislikes)
        .forEach(item => wrap.append(el('span', { text: p.id + '번 ' + item + ' 뺌' })));
    });
    if (!wrap.childNodes.length) return null;
    wrap.style.justifyContent = 'center';
    return wrap;
  }

  /* ---------- 추천 결과 ---------- */
  function renderResults() {
    const count = payload().people.length;
    card.innerHTML = '';
    const wrap = el('div', { class: 'reveal' });

    wrap.append(el('div', { class: 'result-head' }, [
      el('h2', { text: '이 메뉴라면 다 같이 먹을 수 있어요' }),
      el('p', { text: count ? count + '명의 조건을 반영했어요' : '싫어하는 음식이 없어서 인기 메뉴로 골랐어요' }),
      conditionChips()
    ]));

    const list = el('ul', { class: 'menus' });
    state.menus.forEach(m => {
      list.append(el('li', { class: 'menu' }, [
        el('div', { class: 'top' }, [
          el('h3', { text: m.name }),
          m.category ? el('span', { class: 'cat', text: m.category }) : null
        ]),
        el('p', { text: m.reason })
      ]));
    });
    wrap.append(list);

    const again = el('button', { class: 'secondary', type: 'button', text: '다른 메뉴 보기' });
    again.addEventListener('click', () => run('list', again));
    wrap.append(el('div', { class: 'actions' }, [
      el('button', { class: 'secondary', type: 'button', text: '조건 수정하기', onclick: () => renderForm() }),
      again
    ]));
    card.append(wrap);

    const h = card.querySelector('h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  /* ---------- 랜덤 ---------- */
  let spinTimer = null;
  function renderRandom() {
    clearTimeout(spinTimer);
    const menus = state.menus;
    card.innerHTML = '';
    const wrap = el('div', { class: 'reveal' });

    const slot = el('div', { class: 'slot' });
    const label = el('p', { class: 'label', text: '고르는 중…' });
    const name = el('p', { class: 'name', text: '' });
    const desc = el('p', { class: 'desc', text: '' });
    slot.append(label, name, desc);
    wrap.append(slot);

    const final = menus[Math.floor(Math.random() * menus.length)];
    const chips = conditionChips();
    if (chips) { chips.hidden = true; wrap.append(chips); }

    wrap.append(el('div', { class: 'actions' }, [
      el('button', { class: 'secondary', type: 'button', text: '조건 수정하기', onclick: () => { clearTimeout(spinTimer); renderForm(); } }),
      // 다시 뽑기는 이미 받은 후보 안에서 다시 돌려서 API를 추가로 호출하지 않아요
      el('button', { class: 'secondary', type: 'button', text: '다시 뽑기', onclick: renderRandom })
    ]));
    card.append(wrap);

    const land = () => {
      slot.classList.add('landed');
      label.textContent = '오늘은 이거 어때요?';
      name.textContent = final.name;
      desc.textContent = final.reason;
      if (chips) chips.hidden = false;
    };
    if (reduceMotion || menus.length === 1) { land(); return; }

    let tick = 0;
    const total = 14;
    const step = () => {
      tick++;
      name.textContent = menus[tick % menus.length].name;
      if (tick >= total) { land(); return; }
      spinTimer = setTimeout(step, 50 + tick * 12);
    };
    step();
  }

  randomBtn.addEventListener('click', () => run('random'));
  renderForm();
})();
