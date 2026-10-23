// 메뉴피그 화면 (Figma 디자인 기준)
// 흐름: 스플래시 → 첫 화면 → ① 못 먹는 음식 → ② 어떤 식사 → 추천 중 → 오늘의 후보 → 메뉴 확정
// 모든 진행은 "모임 방"(/?room=방ID) 안에서 이뤄져서, 링크를 받은 친구도 같은 화면을 함께 봅니다.
(function () {
  'use strict';

  const QUICK = ['매운 음식', '해산물', '오이', '날것', '마라', '고수', '내장류', '양고기'];
  const MEALS = ['아침', '점심', '저녁'];
  const BUDGETS = ['1만원 이하', '1~2만원', '2~3만원', '3만원 이상', '상관없어요'];
  const MAX_LEN = 100;
  const MAX_NAME = 12;
  const MAX_ALLERGY = 60;
  const MAX_PEOPLE = 10;
  const POLL_MS = 4000;
  const FAST_POLL_MS = 1500;
  const WAIT_LIMIT_MS = 100000;
  const SAVE_DELAY_MS = 600;
  const SPLIT = /[,，、\/·]+/;
  const ASSET = {
    pig: '/assets/pig.png',
    logo: '/assets/logo.png',
    ellipse: '/assets/splash-ellipse.svg',
    back: '/assets/chevron-left.svg',
    share: '/assets/share.svg',
    arrow: '/assets/map-arrow.svg'
  };

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ================= 공통 도구 ================= */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    (children || []).forEach(c => c && node.append(c));
    return node;
  }

  // 이미지가 아직 없으면(Figma에서 내보내기 전) 깨진 아이콘 대신 이모지로 대체
  function img(src, attrs) {
    const node = el('img', { src, alt: '', ...attrs });
    node.addEventListener('error', () => node.replaceWith(el('div', { class: 'img-fallback', text: '🐷', 'aria-hidden': 'true' })));
    return node;
  }

  const items = text => [...new Set(String(text || '').split(SPLIT).map(s => s.trim()).filter(Boolean))];
  const isComposing = e => e.isComposing || e.keyCode === 229;
  const roomLink = id => `${location.origin}/?room=${id}`;

  let toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2400);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* 복사 불가 환경 */ }
      ta.remove();
      return ok;
    }
  }

  async function shareOrCopy({ title, text, url }) {
    if (navigator.share) {
      try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const ok = await copyText(url ? `${text}\n${url}` : text);
    toast(ok ? '복사했어요. 친구들에게 붙여넣어 보내주세요' : '복사하지 못했어요. 주소창의 링크를 직접 보내주세요');
  }

  async function api(method, body) {
    let res;
    try {
      res = method === 'GET'
        ? await fetch(`/api/room?id=${encodeURIComponent(roomId)}`, { cache: 'no-store' })
        : await fetch('/api/room', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
    } catch {
      const err = new Error('인터넷 연결을 확인하고 다시 시도해주세요');
      err.status = 0;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || '요청을 처리하지 못했어요. 잠시 후 다시 시도해주세요');
      err.status = res.status;
      err.gateway = !data.error; // 서버 답이 아니라 중간에서 끊긴 경우
      throw err;
    }
    return data;
  }

  // 이 브라우저에서 관리하는 참가자(나 + 내가 추가한 친구)의 수정 권한 토큰
  const storageKey = id => `menu-picker:room:${id}`;
  function loadLocal(id) {
    let data = {};
    try { data = JSON.parse(localStorage.getItem(storageKey(id)) || '{}') || {}; } catch { /* 무시 */ }
    // 예전 형식 { pid, token } → 새 형식으로 변환
    if (data.pid && data.token && !data.people) {
      data = { hostToken: data.hostToken, people: [{ pid: data.pid, token: data.token }], primary: data.pid };
    }
    return { hostToken: data.hostToken || null, people: Array.isArray(data.people) ? data.people : [], primary: data.primary || null };
  }
  function saveLocal(id, data) {
    try { localStorage.setItem(storageKey(id), JSON.stringify(data)); } catch { /* 저장이 막혀 있어도 동작은 그대로 */ }
  }

  async function createRoom() {
    const res = await fetch('/api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '모임을 만들지 못했어요. 잠시 후 다시 시도해주세요');
    saveLocal(data.room.id, { hostToken: data.hostToken, people: [], primary: null });
    return data.room.id;
  }

  /* ================= 첫 화면 (방 없음) ================= */

  if (!roomId) {
    const showLanding = () => renderLanding();
    let seen = false;
    try { seen = sessionStorage.getItem('menu-picker:splash') === '1'; } catch { /* 무시 */ }
    if (seen) return showLanding();
    try { sessionStorage.setItem('menu-picker:splash', '1'); } catch { /* 무시 */ }
    renderSplash(showLanding);
    return;
  }

  function renderSplash(next) {
    app.innerHTML = '';
    const timer = setTimeout(next, reduceMotion ? 600 : 1300);
    app.append(el('div', {
      class: 'splash', role: 'button', 'aria-label': '메뉴피그 시작하기',
      onclick: () => { clearTimeout(timer); next(); }
    }, [
      el('div', { class: 'splash__logo' }, [
        img(ASSET.ellipse, { class: 'ellipse' }),
        img(ASSET.logo, { class: 'logo', alt: 'MENU PIG!' })
      ])
    ]));
  }

  function renderLanding(options = {}) {
    app.innerHTML = '';
    const start = el('button', { class: 'landing__primary', type: 'button', text: options.primaryText || '지금 같이 고르기' });
    const copy = el('button', { class: 'landing__secondary', type: 'button', text: '링크 복사하기' });

    start.addEventListener('click', async () => {
      start.disabled = copy.disabled = true;
      start.textContent = '모임 만드는 중…';
      try {
        location.href = `/?room=${await createRoom()}`;
      } catch (e) {
        toast(e.message);
        start.disabled = copy.disabled = false;
        start.textContent = options.primaryText || '지금 같이 고르기';
      }
    });

    copy.addEventListener('click', async () => {
      start.disabled = copy.disabled = true;
      copy.textContent = '링크 만드는 중…';
      const idPromise = createRoom();
      // 사파리는 클릭 직후에만 복사를 허용해서, 방이 만들어지기 전에 복사를 먼저 요청해 둠
      let copied = false;
      try {
        if (window.ClipboardItem && navigator.clipboard?.write) {
          const blob = idPromise.then(id => new Blob([roomLink(id)], { type: 'text/plain' }));
          await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
          copied = true;
        }
      } catch { /* 아래에서 다시 시도 */ }
      try {
        const id = await idPromise;
        if (!copied) copied = await copyText(roomLink(id));
        location.href = `/?room=${id}&${copied ? 'copied' : 'share'}=1`;
      } catch (e) {
        toast(e.message);
        start.disabled = copy.disabled = false;
        copy.textContent = '링크 복사하기';
      }
    });

    app.append(el('div', { class: 'landing' }, [
      img(ASSET.pig, { class: 'landing__pig', alt: '고민하는 돼지 캐릭터' }),
      el('h1', { class: 'title', text: options.title || '우리 오늘 뭐 먹지?' }),
      el('p', { class: 'landing__desc' }, (options.desc || ['피하고 싶은 음식만 알려주세요', '함께 먹을 메뉴를 좁혀드릴게요.']).map((line, i) => [i ? el('br') : null, document.createTextNode(line)]).flat()),
      el('div', { class: 'landing__buttons' }, [start, copy])
    ]));
  }

  /* ================= 모임 방 ================= */

  document.title = '우리 오늘 뭐 먹지? | 메뉴피그';
  const local = loadLocal(roomId);
  const S = {
    room: null,
    hostToken: local.hostToken,
    auth: local.people,          // [{ pid, token }] 이 브라우저가 관리하는 참가자
    primary: local.primary,      // "나" 카드의 pid
    drafts: [],                  // 화면에서 편집 중인 내 카드들 (첫 번째가 "나")
    showAllergy: false,
    screen: null,
    enteredAt: 0,
    error: null,
    busy: false,
    waiting: null,               // 추천이 끝나길 기다리는 중: { since, prevResultId, from }
    seenChosenAt: null,
    pollTimer: null,
    ui: {}
  };

  function persist() {
    saveLocal(roomId, {
      hostToken: S.hostToken,
      people: S.auth,
      primary: S.primary
    });
  }

  function makeDraft(p, auth) {
    return {
      pid: p?.pid || null,
      token: auth?.token || null,
      name: p?.name || '',
      items: items(p?.dislikes),
      allergy: p?.allergy || '',
      okTouched: Boolean(p && !p.dislikes),
      customName: Boolean(p),
      adding: false,
      editingName: false,
      timer: null,
      chain: Promise.resolve()
    };
  }

  // 서버의 참가자 목록과 이 브라우저의 토큰을 맞춰서 내 카드 목록을 만듦
  function initDrafts(room) {
    const byPid = new Map(room.participants.map(p => [p.pid, p]));
    S.auth = S.auth.filter(a => byPid.has(a.pid));
    if (S.primary && !byPid.has(S.primary)) S.primary = null;
    if (!S.primary && S.auth.length) S.primary = S.auth[0].pid;
    const ordered = [...S.auth].sort((a, b) => (a.pid === S.primary ? -1 : b.pid === S.primary ? 1 : 0));
    S.drafts = ordered.map(a => makeDraft(byPid.get(a.pid), a));
    if (!S.primary) S.drafts.unshift(makeDraft(null, null)); // 아직 참여 전인 "나"
    persist();
  }

  const isMine = pid => S.drafts.some(d => d.pid === pid);
  const remotePeople = () => (S.room?.participants || []).filter(p => !isMine(p.pid));
  const authFor = () => {
    const d = S.drafts.find(x => x.pid && x.token);
    return d ? { pid: d.pid, token: d.token } : null;
  };

  function nextDefaultName() {
    const used = new Set([
      ...(S.room?.participants || []).map(p => p.name),
      ...S.drafts.map(d => d.name).filter(Boolean)
    ]);
    for (let n = 1; ; n++) if (!used.has(`친구 ${n}`)) return `친구 ${n}`;
  }

  /* ---------- 저장 (입력을 멈추면 자동 저장, 처음 저장할 때 참여) ---------- */

  function queueSave(d, delay = SAVE_DELAY_MS) {
    clearTimeout(d.timer);
    d.timer = setTimeout(() => { d.timer = null; runSave(d); }, delay);
  }

  function runSave(d) {
    d.chain = d.chain.then(() => doSave(d)).catch(() => {});
    return d.chain;
  }

  async function doSave(d, retried = false) {
    const payload = { name: d.name || nextDefaultName(), dislikes: d.items.join(', '), allergy: d.allergy };
    try {
      if (!d.pid) {
        const { room, me } = await api('POST', { action: 'join', id: roomId, ...payload });
        Object.assign(d, { pid: me.pid, token: me.token, name: payload.name });
        S.auth.push(me);
        if (d === S.drafts[0] && !S.primary) S.primary = me.pid;
        persist();
        apply(room);
      } else {
        const { room } = await api('POST', { action: 'update', id: roomId, pid: d.pid, token: d.token, ...payload });
        apply(room);
      }
    } catch (e) {
      if (e.status === 403) return dropDraft(d, '목록에서 빠져서 다시 참여했어요');
      if (e.status === 409 && !d.pid && !d.customName && !retried) {
        apply((await api('GET')).room);
        d.name = '';
        if (d !== S.drafts[0]) d.name = nextDefaultName();
        return doSave(d, true);
      }
      toast(e.message);
      throw e;
    }
  }

  async function flushSaves() {
    for (const d of S.drafts) {
      if (d.timer) { clearTimeout(d.timer); d.timer = null; runSave(d); }
    }
    await Promise.all(S.drafts.map(d => d.chain));
  }

  async function ensureJoined() {
    await flushSaves();
    const first = S.drafts[0];
    if (first && !first.pid) await runSave(first);
    if (!authFor()) throw new Error('참여에 실패했어요. 잠시 후 다시 시도해주세요');
  }

  // 방장이 목록에서 뺐거나 기록이 사라진 경우
  function dropDraft(d, message) {
    S.auth = S.auth.filter(a => a.pid !== d.pid);
    if (S.primary === d.pid) S.primary = null;
    const wasPrimary = d === S.drafts[0];
    S.drafts = S.drafts.filter(x => x !== d);
    if (wasPrimary) S.drafts.unshift(makeDraft(null, null));
    persist();
    if (message) toast(message);
    if (S.screen === 'food') renderLocalCards();
  }

  /* ---------- 화면 이동 ---------- */

  const PARENT = { food: null, meal: 'food', loading: 'meal', results: 'meal', confirmed: 'results' };

  function go(screen, { replace = false } = {}) {
    const depth = (history.state?.depth || 0) + (replace ? 0 : 1);
    const state = { screen, depth };
    const url = `/?room=${roomId}`;
    if (replace) history.replaceState(state, '', url);
    else history.pushState(state, '', url);
    show(screen);
  }

  function back() {
    if ((history.state?.depth || 0) > 0) return history.back();
    const parent = PARENT[S.screen];
    if (!parent) { location.href = '/'; return; }
    go(parent, { replace: true });
  }

  window.addEventListener('popstate', e => {
    if (e.state?.screen) show(e.state.screen);
  });

  function initialScreen(room) {
    if (room.pending) return 'loading';
    if (room.result?.chosen !== null && room.result?.chosen !== undefined) return 'confirmed';
    if (room.result) return 'results';
    return 'food';
  }

  function show(screen) {
    if ((screen === 'results' || screen === 'confirmed') && !S.room?.result) screen = 'food';
    if (screen === 'confirmed' && (S.room.result.chosen === null || S.room.result.chosen === undefined)) screen = 'results';
    if (screen === 'loading' && !S.waiting && !S.room?.pending) screen = S.room?.result ? 'results' : 'meal';
    S.screen = screen;
    S.enteredAt = Date.now();
    S.ui = {};
    app.innerHTML = '';
    ({ food: renderFood, meal: renderMeal, loading: renderLoading, results: renderResults, confirmed: renderConfirmed })[screen]();
    S.error = null;
    window.scrollTo(0, 0);
  }

  /* ---------- 화면 공통 조각 ---------- */

  function header({ progress = null, share = false } = {}) {
    return el('header', { class: 'topbar' }, [
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': '뒤로', onclick: back }, [img(ASSET.back)]),
      progress
        ? el('div', { class: 'progress', 'aria-label': `3단계 중 ${progress}단계` }, [1, 2, 3].map(n => el('span', { class: n <= progress ? 'on' : '' })))
        : el('span'),
      share
        ? el('button', { class: 'icon-btn icon-btn--share', type: 'button', 'aria-label': '모임 링크 공유', onclick: shareRoom }, [img(ASSET.share)])
        : el('span')
    ]);
  }

  function shareRoom() {
    shareOrCopy({ title: '메뉴피그', text: '못 먹는 음식만 골라줘! 같이 메뉴 정하자 🐷', url: roomLink(roomId) });
  }

  function errorLine() {
    const p = el('p', { class: 'error', role: 'alert', text: S.error || '', hidden: !S.error });
    S.ui.error = p;
    return p;
  }
  function setError(message) {
    S.error = message;
    if (S.ui.error) { S.ui.error.textContent = message || ''; S.ui.error.hidden = !message; }
  }

  // 1, 2단계 화면에서 다른 사람이 추천을 시작했거나 결과가 나왔을 때 알려주는 띠
  function noticeSlot() {
    const box = el('div');
    S.ui.notice = box;
    updateNotice();
    return box;
  }
  function updateNotice() {
    const box = S.ui.notice;
    if (!box) return;
    box.innerHTML = '';
    const room = S.room;
    if (room.pending && !S.waiting) {
      box.append(el('div', { class: 'notice-bar' }, [
        el('span', { text: `${room.pending.by}님이 메뉴를 고르고 있어요` }),
        el('button', { type: 'button', text: '보러 가기', onclick: () => { startWatching(); go('loading'); } })
      ]));
    } else if (room.result && room.result.createdAt > S.enteredAt) {
      box.append(el('div', { class: 'notice-bar' }, [
        el('span', { text: '추천 결과가 나왔어요' }),
        el('button', { type: 'button', text: '보기', onclick: () => go(initialScreen(room)) })
      ]));
    }
  }

  // 어떤 조건이 반영됐는지 보여주는 칩 문구
  function conditions(people, options) {
    const dislikes = [...new Set(people.flatMap(p => items(p.dislikes)))];
    const allergies = [...new Set(people.flatMap(p => items(p.allergy)))];
    const list = [`${people.length}명`, options.meal];
    if (dislikes.length) {
      const shown = dislikes.slice(0, 3).join(', ');
      list.push(`${shown}${dislikes.length > 3 ? ` 외 ${dislikes.length - 3}개` : ''} 제외`);
    } else {
      list.push('가리는 음식 없음');
    }
    list.push(allergies.length ? `알레르기: ${allergies.slice(0, 3).join(', ')}` : '알레르기식품 없음');
    list.push(options.alcohol ? '술 곁들여요' : '술 없이 먹어요');
    if (options.budget && options.budget !== '상관없어요') list.push(`1인 ${options.budget}`);
    return list;
  }

  /* ================= ① 못 먹는 음식이 있나요? ================= */

  function renderFood() {
    const content = el('main', { class: 'content' });
    content.append(el('h1', { class: 'title', text: '못 먹는 음식이 있나요?' }));

    S.ui.local = el('div', { class: 'people' });
    S.ui.remote = el('div', { class: 'people' });
    content.append(S.ui.local, S.ui.remote);
    renderLocalCards();
    renderRemoteCards();

    const add = el('button', { class: 'outline-btn', type: 'button', text: '+ 친구 추가', onclick: addFriend });
    const allergy = el('button', {
      class: 'outline-btn outline-btn--muted', type: 'button',
      text: S.showAllergy ? '알레르기 입력 닫기' : '알레르기 입력하기',
      onclick: () => {
        S.showAllergy = !S.showAllergy;
        allergy.textContent = S.showAllergy ? '알레르기 입력 닫기' : '알레르기 입력하기';
        renderLocalCards();
      }
    });
    S.ui.add = add;
    content.append(el('div', { class: 'people-actions' }, [add, allergy]));

    const next = el('button', { class: 'cta-btn', type: 'button', text: '다음' });
    next.addEventListener('click', async () => {
      next.disabled = true;
      try {
        await ensureJoined();
        go('meal');
      } catch (e) {
        setError(e.message);
        next.disabled = false;
      }
    });

    app.append(el('div', { class: 'screen' }, [
      header({ progress: 1, share: true }),
      content,
      el('footer', { class: 'cta' }, [noticeSlot(), errorLine(), next])
    ]));
  }

  function renderLocalCards() {
    const box = S.ui.local;
    if (!box) return;
    box.innerHTML = '';
    S.drafts.forEach((d, i) => box.append(buildLocalCard(d, i === 0)));
    if (S.ui.add) S.ui.add.disabled = (S.room.participants.length + (S.drafts[0]?.pid ? 0 : 1)) >= MAX_PEOPLE;
  }

  function rerenderCard(d, focusSelector) {
    const old = S.ui.local?.querySelector(`[data-card="${S.drafts.indexOf(d)}"]`);
    if (!old) return renderLocalCards();
    const fresh = buildLocalCard(d, d === S.drafts[0]);
    old.replaceWith(fresh);
    if (focusSelector) fresh.querySelector(focusSelector)?.focus();
  }

  function buildLocalCard(d, isPrimary) {
    const card = el('section', { class: 'pcard', 'data-card': String(S.drafts.indexOf(d)) });

    // 머리: 이름 + 이름 수정 / 삭제
    const head = el('div', { class: 'pcard__head' });
    if (d.editingName) {
      const input = el('input', { class: 'name-input', type: 'text', maxlength: String(MAX_NAME), value: d.name, 'aria-label': '이름', 'data-focus': 'name' });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const value = input.value.replace(/\s+/g, ' ').trim();
        if (value && value !== d.name) { d.name = value; d.customName = true; queueSave(d, 0); }
        d.editingName = false;
        rerenderCard(d);
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); finish(); } });
      input.addEventListener('blur', finish);
      head.append(input);
      setTimeout(() => input.focus(), 0);
    } else {
      head.append(el('span', { class: 'pcard__name' }, isPrimary
        ? [document.createTextNode('나'), d.name ? el('small', { text: `(${d.name})` }) : null]
        : [document.createTextNode(d.name || '친구')]));
      const tools = el('div', { class: 'pcard__tools' }, [
        el('button', { class: 'text-btn', type: 'button', text: '이름 수정', onclick: () => { d.editingName = true; if (!d.name) d.name = nextDefaultName(); rerenderCard(d); } })
      ]);
      if (!isPrimary) tools.append(el('button', { class: 'text-btn', type: 'button', text: '삭제', onclick: () => removeFriend(d) }));
      head.append(tools);
    }
    card.append(head);

    // 자주 쓰는 항목 + 직접 추가한 항목
    const custom = d.items.filter(x => !QUICK.includes(x));
    const chips = el('div', { class: 'chips' });
    [...QUICK, ...custom].forEach(label => chips.append(el('button', {
      class: 'chip', type: 'button', text: label, 'aria-pressed': String(d.items.includes(label)),
      onclick: () => toggleItem(d, label)
    })));
    card.append(chips);

    const actions = el('div', { class: 'chips chips--actions' }, [
      el('button', {
        class: 'chip chip--action', type: 'button', text: '직접 추가하기', 'aria-expanded': String(d.adding),
        onclick: () => { d.adding = !d.adding; rerenderCard(d, d.adding ? '[data-focus="add"]' : null); }
      }),
      el('button', {
        class: 'chip chip--action', type: 'button', text: '다 괜찮아요',
        'aria-pressed': String(d.okTouched && d.items.length === 0),
        onclick: () => { d.items = []; d.okTouched = true; rerenderCard(d); queueSave(d); }
      })
    ]);
    card.append(actions);

    if (d.adding) {
      const input = el('input', { class: 'field', type: 'text', maxlength: '20', placeholder: '예: 가지, 파스타', 'aria-label': '직접 추가할 음식', 'data-focus': 'add' });
      const addNow = () => {
        const list = items(input.value);
        if (!list.length) return;
        const next = [...new Set([...d.items, ...list])];
        if (next.join(', ').length > MAX_LEN) { toast(`${MAX_LEN}자까지 적을 수 있어요`); return; }
        d.items = next;
        d.okTouched = false;
        rerenderCard(d, '[data-focus="add"]');
        queueSave(d);
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); addNow(); } });
      card.append(el('div', { class: 'field-row' }, [
        input,
        el('button', { class: 'chip chip--action', type: 'button', text: '추가', onclick: addNow })
      ]));
    }

    if (S.showAllergy || d.allergy) {
      const input = el('input', { class: 'field', type: 'text', maxlength: String(MAX_ALLERGY), value: d.allergy, placeholder: '예: 땅콩, 갑각류', 'aria-label': '알레르기' });
      input.addEventListener('input', () => { d.allergy = input.value; queueSave(d); });
      card.append(el('div', { class: 'field-row' }, [el('label', { text: '알레르기' }), input]));
    }
    return card;
  }

  function toggleItem(d, label) {
    const has = d.items.includes(label);
    const next = has ? d.items.filter(x => x !== label) : [...d.items, label];
    if (next.join(', ').length > MAX_LEN) { toast(`${MAX_LEN}자까지 적을 수 있어요`); return; }
    d.items = next;
    d.okTouched = false;
    rerenderCard(d);
    queueSave(d);
  }

  async function addFriend() {
    const total = S.room.participants.length + (S.drafts[0]?.pid ? 0 : 1);
    if (total >= MAX_PEOPLE) { toast(`한 모임에는 ${MAX_PEOPLE}명까지 함께할 수 있어요`); return; }
    const d = makeDraft(null, null);
    d.name = nextDefaultName();
    S.drafts.push(d);
    renderLocalCards();
    runSave(d); // 바로 참여시켜서 다른 사람 화면에도 보이게
  }

  async function removeFriend(d) {
    if (!confirm(`${d.name || '친구'} 카드를 삭제할까요?`)) return;
    clearTimeout(d.timer);
    await d.chain;
    if (d.pid) {
      try {
        apply((await api('POST', { action: 'remove', id: roomId, pid: d.pid, token: d.token })).room);
      } catch (e) {
        if (e.status !== 404) { toast(e.message); return; }
      }
    }
    S.auth = S.auth.filter(a => a.pid !== d.pid);
    S.drafts = S.drafts.filter(x => x !== d);
    persist();
    renderLocalCards();
  }

  // 링크로 들어와 각자 입력 중인 사람들 (읽기 전용)
  function renderRemoteCards() {
    const box = S.ui.remote;
    if (!box) return;
    box.innerHTML = '';
    remotePeople().forEach(p => {
      const list = items(p.dislikes);
      box.append(el('section', { class: 'pcard' }, [
        el('div', { class: 'pcard__head' }, [
          el('span', { class: 'pcard__name', text: p.name }),
          el('span', { class: 'pcard__badge', text: '직접 입력 중' })
        ]),
        list.length
          ? el('div', { class: 'chips' }, list.map(x => el('span', { class: 'chip chip--static', text: x })))
          : el('p', { class: 'pcard__empty', text: '가리는 음식 없어요' }),
        p.allergy ? el('p', { class: 'pcard__allergy', text: `알레르기: ${p.allergy}` }) : null
      ]));
    });
    box.hidden = !box.childElementCount;
  }

  /* ================= ② 어떤 식사인가요? ================= */

  function renderMeal() {
    const content = el('main', { class: 'content' }, [
      el('h1', { class: 'title', text: '어떤 식사인가요?' }),
      el('p', { class: 'subtitle', text: '식사에 대한 정보를 입력해주세요' })
    ]);
    S.ui.questions = el('div');
    content.append(S.ui.questions);
    renderQuestions();

    const make = el('button', { class: 'cta-btn', type: 'button', text: '모임 만들기', onclick: () => startRecommend(make) });
    app.append(el('div', { class: 'screen' }, [
      header({ progress: 2, share: true }),
      content,
      el('footer', { class: 'cta' }, [noticeSlot(), errorLine(), make])
    ]));
  }

  function renderQuestions() {
    const box = S.ui.questions;
    if (!box) return;
    const o = { ...S.room.options, ...(S.optimistic || {}) };
    const group = (num, label, values, current, small, key, toValue) => el('section', { class: 'q' }, [
      el('h2', { class: 'q__label' }, [el('span', { class: 'q__num', text: String(num), 'aria-hidden': 'true' }), document.createTextNode(label)]),
      el('div', { class: 'opts', role: 'group', 'aria-label': label }, values.map(v => el('button', {
        class: small ? 'opt opt--sm' : 'opt', type: 'button', text: v, 'aria-pressed': String(v === current),
        onclick: () => setOption(key, toValue(v))
      })))
    ]);
    box.innerHTML = '';
    box.append(
      group(1, '식사 시간', MEALS, o.meal, false, 'meal', v => v),
      group(2, '편한 금액대는 어느 정도인가요?', BUDGETS, o.budget || '상관없어요', true, 'budget', v => v),
      group(3, '술도 함께 하나요?', ['안 마셔요', '마실 거에요'], o.alcohol ? '마실 거에요' : '안 마셔요', false, 'alcohol', v => v === '마실 거에요')
    );
  }

  async function setOption(key, value) {
    S.optimistic = { ...(S.optimistic || {}), [key]: value };
    renderQuestions();
    try {
      await ensureJoined();
      const next = { ...S.room.options, ...S.optimistic };
      const { room } = await api('POST', { action: 'options', id: roomId, ...authFor(), options: next });
      S.optimistic = null;
      apply(room);
    } catch (e) {
      S.optimistic = null;
      setError(e.message);
      renderQuestions();
    }
  }

  /* ================= 추천 받기 ================= */

  async function startRecommend(button) {
    if (S.busy || S.waiting) return;
    S.busy = true;
    setError(null);
    if (button) button.disabled = true;
    try {
      await ensureJoined();
    } catch (e) {
      S.busy = false;
      if (button) button.disabled = false;
      setError(e.message);
      return;
    }
    const from = S.screen;
    S.waiting = { since: Date.now(), prevResultId: S.room.result?.id || null, from };
    go('loading');
    try {
      const { room } = await api('POST', { action: 'recommend', id: roomId, ...authFor(), mode: 'list' });
      S.busy = false;
      apply(room);
    } catch (e) {
      S.busy = false;
      // 이미 누군가 고르는 중이거나 응답만 중간에 끊긴 경우: 결과가 나올 때까지 기다림
      const inProgress = e.status === 409 || e.status === 0 || (e.gateway && e.status >= 500);
      if (inProgress) { poll(); return; }
      S.waiting = null;
      S.error = e.message;
      go(from === 'results' ? 'results' : 'meal', { replace: true });
    }
  }

  // 다른 사람이 시작한 추천을 같이 기다릴 때
  function startWatching() {
    S.waiting = { since: Date.now(), prevResultId: S.room.result?.id || null, from: S.screen };
  }

  function checkWaiting(room) {
    const w = S.waiting;
    if (!w) return;
    const elapsed = Date.now() - w.since;
    if (room.result && room.result.id !== w.prevResultId) {
      S.waiting = null;
      S.seenChosenAt = room.result.chosenAt || null;
      if (S.screen === 'loading') go('results', { replace: true });
    } else if ((!room.pending && elapsed > 3000) || elapsed > WAIT_LIMIT_MS) {
      if (S.busy) return; // 내 요청의 응답이 곧 도착하니 그 결과로 처리
      S.waiting = null;
      S.error = '메뉴를 고르지 못했어요. 잠시 후 다시 눌러주세요';
      if (S.screen === 'loading') go(w.from === 'results' ? 'results' : 'meal', { replace: true });
    }
  }

  /* ================= 함께 먹을 후보를 고르고 있어요 ================= */

  function renderLoading() {
    const room = S.room;
    if (!S.waiting) startWatching();
    const title = el('h1', { class: 'title' }, [
      document.createTextNode('함께 먹을 후보를'), el('br'), document.createTextNode('고르고 있어요'),
      el('span', { class: 'dots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')])
    ]);
    S.ui.loadSub = el('p', { class: 'subtitle', text: `${room.participants.length}명의 조건을 고려했어요.` });
    S.ui.conds = el('div', { class: 'conds' }, conditions(room.participants, room.options).map(c => el('span', { class: 'cond', text: c })));
    const content = el('main', { class: 'content' }, [title, S.ui.loadSub, S.ui.conds]);
    content.querySelector('.subtitle').style.marginTop = '11px';

    S.ui.resultBtn = el('button', { class: 'btn', type: 'button', text: '추천 결과를 준비하고 있어요', disabled: true, onclick: () => go('results', { replace: true }) });
    app.append(el('div', { class: 'screen' }, [
      header(),
      content,
      el('footer', { class: 'cta cta--wide' }, [errorLine(), S.ui.resultBtn])
    ]));
  }

  function updateLoading(room) {
    if (S.ui.loadSub) S.ui.loadSub.textContent = `${room.participants.length}명의 조건을 고려했어요.`;
    if (S.ui.conds) {
      S.ui.conds.innerHTML = '';
      conditions(room.participants, room.options).forEach(c => S.ui.conds.append(el('span', { class: 'cond', text: c })));
    }
  }

  /* ================= 오늘의 후보 ================= */

  // 후보 카드 첫 줄: 모든 후보에 공통으로 반영된 조건 요약
  function pointLine(people) {
    const all = [...new Set(people.flatMap(p => items(p.dislikes)))];
    const allergy = people.some(p => p.allergy);
    const lead = all.includes('매운 음식') ? '맵지 않은 후보'
      : all.length ? `${all[0]} 없는 후보`
      : '모두 먹기 무난한 후보';
    return `${lead} · ${allergy ? '알레르기 재료 꼭 확인' : '재료 확인 필요'}`;
  }

  function isStale(room) {
    const snap = room.result?.people;
    if (!snap) return false;
    const key = list => list.map(p => `${p.name}:${p.dislikes}:${p.allergy || ''}`).sort().join('|');
    const o = room.result.options || {};
    const now = room.options;
    return key(snap) !== key(room.participants) || o.meal !== now.meal || o.alcohol !== now.alcohol || (o.budget || '상관없어요') !== (now.budget || '상관없어요');
  }

  function renderResults() {
    const r = S.room.result;
    const people = r.people || S.room.participants;
    S.ui.resultId = r.id;
    const point = pointLine(people);

    const content = el('main', { class: 'content' }, [
      el('h1', { class: 'title', text: `오늘의 후보 ${r.menus.length}개` }),
      el('p', { class: 'subtitle', text: `${people.length}명의 조건을 고려했어요.` })
    ]);
    S.ui.stale = el('p', { class: 'stale', text: '후보가 나온 뒤에 조건이 바뀌었어요. 다른 후보를 다시 받아보세요.', hidden: !isStale(S.room) });
    content.append(S.ui.stale);

    content.append(el('div', { class: 'menus' }, r.menus.map((m, i) => {
      const pick = el('button', { class: 'btn btn--green', type: 'button', text: '이 메뉴로 정하기' });
      pick.addEventListener('click', () => choose(i, pick));
      return el('article', { class: 'mcard' }, [
        el('h3', { text: `${m.name}  ·  ${m.category || '기타'}` }),
        el('p', { class: 'mcard__point', text: point }),
        m.reason ? el('p', { class: 'mcard__reason', text: m.reason }) : null,
        pick
      ]);
    })));

    const more = el('button', { class: 'btn btn--shadow', type: 'button', text: '다른 후보 3개 보기', onclick: () => startRecommend(more) });
    app.append(el('div', { class: 'screen' }, [
      header(),
      content,
      el('footer', { class: 'cta cta--wide' }, [errorLine(), more])
    ]));
  }

  async function choose(index, button) {
    if (button) button.disabled = true;
    try {
      await ensureJoined();
      const { room } = await api('POST', { action: 'choose', id: roomId, ...authFor(), index });
      S.seenChosenAt = room.result.chosenAt;
      apply(room);
      go(index === null ? 'results' : 'confirmed', { replace: index === null });
    } catch (e) {
      if (button) button.disabled = false;
      setError(e.message);
    }
  }

  /* ================= 오늘의 메뉴 확정! ================= */

  function renderConfirmed() {
    const r = S.room.result;
    const m = r.menus[r.chosen];
    const options = r.options || S.room.options;
    const people = r.people || S.room.participants;
    const mapUrl = `https://map.naver.com/p/search/${encodeURIComponent(m.name)}`;
    const searchUrl = `https://m.search.naver.com/search.naver?query=${encodeURIComponent(`${m.name} 맛집`)}`;
    const sub = [m.category || '기타', options.budget && options.budget !== '상관없어요' ? `1인 ${options.budget}` : null].filter(Boolean).join(' · ');
    const tags = [`${people.length}명`, options.meal, options.alcohol ? '술 곁들여요' : '술 없이'];

    const content = el('main', { class: 'content' }, [
      el('h1', { class: 'title', text: '오늘의 메뉴 확정!' }),
      el('p', { class: 'subtitle', text: r.chosenBy ? `${r.chosenBy}님이 오늘 모임 메뉴를 확정했어요` : '오늘 모임 메뉴를 확정했어요' }),
      el('article', { class: 'confirm' }, [
        el('div', { class: 'confirm__visual' }, [img(ASSET.pig, { alt: '' })]),
        el('div', { class: 'confirm__panel' }, [
          el('h2', { class: 'confirm__name', text: m.name }),
          el('p', { class: 'confirm__sub', text: sub }),
          el('div', { class: 'tags' }, tags.map(t => el('span', { class: 'tag', text: t }))),
          el('a', { class: 'map-btn', href: mapUrl, target: '_blank', rel: 'noopener' }, [
            document.createTextNode('네이버지도에서 보기'), img(ASSET.arrow)
          ])
        ])
      ]),
      m.reason ? el('p', { class: 'confirm__reason', text: m.reason }) : null,
      el('div', { class: 'spacer' }),
      el('div', { class: 'btn-stack' }, [
        el('button', {
          class: 'btn btn--green', type: 'button', text: '결과 공유하기',
          onclick: () => shareOrCopy({ title: '메뉴피그', text: `오늘 우리 메뉴는 ${m.name}! 🐷`, url: roomLink(roomId) })
        }),
        el('a', { class: 'btn', href: searchUrl, target: '_blank', rel: 'noopener', text: '식당 찾아보기' }),
        el('button', { class: 'btn', type: 'button', text: '메뉴 다시 고르기', onclick: e => choose(null, e.currentTarget) })
      ]),
      errorLine()
    ]);
    content.style.paddingBottom = 'calc(env(safe-area-inset-bottom, 0px) + 30px)';

    app.append(el('div', { class: 'screen' }, [header(), content]));
  }

  /* ================= 서버 상태 반영과 자동 새로고침 ================= */

  function apply(room) {
    // 늦게 도착한 예전 응답이 최신 상태를 덮어쓰지 않도록 무시
    if (S.room && room.version < S.room.version) return;
    const prev = S.room;
    S.room = room;

    // 방장이 내 카드를 뺐으면 정리
    for (const d of [...S.drafts]) {
      if (d.pid && !d.timer && !room.participants.some(p => p.pid === d.pid)) dropDraft(d, '목록에서 빠졌어요');
    }

    checkWaiting(room);
    const r = room.result;

    switch (S.screen) {
      case 'food':
        renderRemoteCards();
        updateNotice();
        break;
      case 'meal':
        if (!S.optimistic && JSON.stringify(prev?.options) !== JSON.stringify(room.options)) renderQuestions();
        updateNotice();
        break;
      case 'loading':
        updateLoading(room);
        if (!S.waiting && r && r.id !== prev?.result?.id) go('results', { replace: true });
        break;
      case 'results':
        if (r && r.chosen !== null && r.chosen !== undefined && r.chosenAt !== S.seenChosenAt) {
          S.seenChosenAt = r.chosenAt;
          go('confirmed');
        } else if (r && r.id !== S.ui.resultId) {
          show('results');
        } else if (S.ui.stale) {
          S.ui.stale.hidden = !isStale(room);
        }
        break;
      case 'confirmed':
        if (!r || r.chosen === null || r.chosen === undefined) go('results', { replace: true });
        else if (r.chosenAt !== S.seenChosenAt) { S.seenChosenAt = r.chosenAt; show('confirmed'); }
        break;
    }
  }

  async function poll() {
    clearTimeout(S.pollTimer);
    if (document.visibilityState === 'visible') {
      try {
        apply((await api('GET')).room);
      } catch (e) {
        if (e.status === 404) return showExpired();
      }
    }
    const fast = S.waiting || S.room?.pending;
    S.pollTimer = setTimeout(poll, fast ? FAST_POLL_MS : POLL_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });

  function showExpired() {
    clearTimeout(S.pollTimer);
    renderLanding({
      title: '모임을 찾지 못했어요',
      desc: ['링크가 잘못됐거나', '48시간 동안 쓰지 않아 사라진 모임이에요.'],
      primaryText: '새 모임 만들기'
    });
  }

  /* ================= 시작 ================= */

  (async () => {
    try {
      const { room } = await api('GET');
      S.room = room;
      initDrafts(room);
      S.seenChosenAt = room.result?.chosenAt || null;

      const screen = initialScreen(room);
      if (screen === 'loading') startWatching();
      history.replaceState({ screen, depth: 0 }, '', `/?room=${roomId}`);
      show(screen);

      if (params.get('copied')) toast('링크를 복사했어요. 친구들에게 보내주세요');
      else if (params.get('share')) toast('오른쪽 위 공유 버튼으로 링크를 보낼 수 있어요');
      S.pollTimer = setTimeout(poll, POLL_MS);
    } catch (e) {
      if (e.status === 404) return showExpired();
      app.innerHTML = '';
      app.append(el('div', { class: 'screen' }, [el('main', { class: 'content' }, [
        el('h1', { class: 'title', text: '잠시 문제가 생겼어요' }),
        el('p', { class: 'subtitle', text: e.message })
      ])]));
    }
  })();
})();
