// 링크 공유 방 화면
// - 혼자 입력 화면에서는 "링크로 친구들과 정하기" 버튼으로 방을 만듦
// - 주소가 /?room=방ID 이면 방 화면을 그림
(function () {
  const MAX_LEN = 100;
  const MAX_NAME = 12;
  const POLL_MS = 4000;
  const FAST_POLL_MS = 1500;      // 누군가 메뉴를 고르는 중일 때는 더 자주 확인
  const WAIT_LIMIT_MS = 100000;   // 결과를 기다리는 최대 시간
  const QUICK = ['매운 음식', '해산물', '오이', '고수', '날것', '내장', '물에 빠진 고기'];
  const SPLIT = /[,，、\/·]+/;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const roomId = new URLSearchParams(location.search).get('room');

  /* ---------------- 공통 도구 ---------------- */

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
  const mascot = () => document.getElementById('mascotTpl').content.cloneNode(true);
  const items = text => [...new Set(String(text || '').split(SPLIT).map(s => s.trim()).filter(Boolean))];
  const isComposing = e => e.isComposing || e.keyCode === 229;

  const storageKey = id => `menu-picker:room:${id}`;
  function loadLocal(id) {
    try { return JSON.parse(localStorage.getItem(storageKey(id)) || '{}') || {}; } catch { return {}; }
  }
  function saveLocal(id, data) {
    try { localStorage.setItem(storageKey(id), JSON.stringify(data)); } catch { /* 저장이 막혀 있어도 동작은 그대로 */ }
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
      err.gateway = !data.error; // 서버 답이 아니라 중간에서 끊긴 경우 (응답 대기 시간 초과 등)
      throw err;
    }
    return data;
  }

  async function createRoom(button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = '방 만드는 중…';
    try {
      const { room, hostToken } = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create' })
      }).then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || '방을 만들지 못했어요. 잠시 후 다시 시도해주세요');
        return d;
      });
      saveLocal(room.id, { hostToken });
      location.href = `/?room=${room.id}`;
    } catch (e) {
      alert(e.message);
      button.disabled = false;
      button.textContent = label;
    }
  }

  function timeAgo(ts) {
    const min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return '방금';
    if (min < 60) return `${min}분 전에`;
    return `${Math.floor(min / 60)}시간 전에`;
  }

  /* ---------------- 혼자 입력 화면: 방 만들기 버튼만 연결 ---------------- */

  if (!roomId) {
    const btn = document.getElementById('roomBtn');
    if (btn) btn.addEventListener('click', () => createRoom(btn));
    return;
  }

  /* ---------------- 방 화면 ---------------- */

  document.getElementById('solo')?.remove();
  const page = document.getElementById('room');
  page.hidden = false;
  document.title = '같이 고르는 메뉴 | 다같이 뭐 먹지';

  const local = loadLocal(roomId);
  const state = {
    room: null,
    me: local.pid && local.token ? { pid: local.pid, token: local.token } : null,
    hostToken: local.hostToken || null,
    busy: false,
    waiting: null, // 추천이 끝나길 기다리는 중: { since, prevResultId }
    lastResultId: null,
    renderedVersion: -1,
    firstRender: true,
    flushSave: null,
    pollTimer: null,
    saveTimer: null
  };
  const persist = () => saveLocal(roomId, { ...(state.me || {}), hostToken: state.hostToken || undefined });
  const link = `${location.origin}/?room=${roomId}`;

  // 화면 뼈대는 한 번만 만들고, 이후에는 바뀐 부분만 갱신 (입력 중인 칸이 지워지지 않도록)
  const ui = {
    resultCard: el('section', { class: 'card', 'aria-live': 'polite', hidden: true }),
    roomCard: el('section', { class: 'card' }),
    meBox: el('div'),
    peopleTitle: el('h2', { class: 'section-title' }),
    people: el('ul', { class: 'people' }),
    opts: el('details', { class: 'opts' }),
    error: el('p', { class: 'error', role: 'alert', hidden: true }),
    pending: el('p', { class: 'pending', 'aria-live': 'polite', hidden: true }),
    recommendBtn: el('button', { class: 'primary', type: 'button', text: '메뉴 추천받기' }),
    randomBtn: el('button', { class: 'random-link', type: 'button', text: '랜덤으로 메뉴 고르기' })
  };

  function showError(message) {
    ui.error.textContent = message || '';
    ui.error.hidden = !message;
  }

  function buildSkeleton() {
    const hero = el('div', { class: 'hero compact' });
    hero.append(mascot());
    hero.append(el('h1', { text: '다 같이 고르는 메뉴' }));
    hero.append(el('p', { text: '링크를 받은 사람은 누구나 자기가 싫어하는 음식을 적을 수 있어요' }));

    const linkInput = el('input', { type: 'text', value: link, readonly: true, 'aria-label': '방 링크' });
    linkInput.addEventListener('focus', () => linkInput.select());
    const copyBtn = el('button', { class: 'secondary small', type: 'button', text: '링크 복사' });
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        linkInput.select();
        document.execCommand('copy');
      }
      copyBtn.textContent = '복사했어요';
      setTimeout(() => { copyBtn.textContent = '링크 복사'; }, 1600);
    });
    const share = el('div', { class: 'share' }, [linkInput, copyBtn]);
    if (navigator.share) {
      share.append(el('button', {
        class: 'secondary small', type: 'button', text: '공유',
        onclick: () => navigator.share({ title: '다같이 뭐 먹지', text: '싫어하는 음식 적어줘! 같이 메뉴 정하자', url: link }).catch(() => {})
      }));
    }

    ui.opts.append(el('summary', { text: '식사 옵션' }));
    ui.opts.append(el('div', { class: 'opt-grid' }));

    ui.recommendBtn.addEventListener('click', () => recommend('list', ui.recommendBtn));
    ui.randomBtn.addEventListener('click', () => recommend('random', ui.randomBtn));

    ui.roomCard.append(
      hero, share, ui.meBox, ui.peopleTitle, ui.people, ui.opts,
      ui.error, ui.pending, ui.recommendBtn,
      el('p', { class: 'note', text: 'HyperCLOVA X가 추천해요. 알레르기가 있다면 식당에서 재료를 꼭 확인해주세요.' })
    );
    page.append(
      ui.resultCard,
      ui.roomCard,
      el('div', { class: 'pills' }, [ui.randomBtn, el('a', { class: 'random-link', href: '/', text: '혼자 정하기' })])
    );
  }

  /* ---------------- 내 입력 영역 ---------------- */

  function chipsFor(input, onChange) {
    const wrap = el('div', { class: 'quick' }, [el('span', { text: '눌러서 추가' })]);
    const sync = () => {
      const current = items(input.value);
      wrap.querySelectorAll('.chip').forEach(b => b.setAttribute('aria-pressed', String(current.includes(b.textContent))));
    };
    QUICK.forEach(q => wrap.append(el('button', {
      class: 'chip', type: 'button', text: q, 'aria-pressed': 'false',
      onclick: () => {
        const list = items(input.value);
        const i = list.indexOf(q);
        if (i >= 0) list.splice(i, 1); else list.push(q);
        const next = list.join(', ');
        if (next.length > MAX_LEN) return;
        input.value = next;
        sync();
        onChange();
        input.focus();
      }
    })));
    input.addEventListener('input', sync);
    sync();
    return wrap;
  }

  function field(label, input) {
    return el('div', { class: 'row' }, [el('span', { class: 'lab', text: label }), input]);
  }

  function renderJoin(notice) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    state.flushSave = null;
    ui.meBox.innerHTML = '';
    let savedName = '';
    try { savedName = localStorage.getItem('menu-picker:name') || ''; } catch { /* 무시 */ }
    const name = el('input', { type: 'text', maxlength: String(MAX_NAME), placeholder: '이름이나 별명', 'aria-label': '내 이름', autocomplete: 'nickname', value: savedName });
    const food = el('input', { type: 'text', maxlength: String(MAX_LEN), placeholder: '싫어하는 음식을 입력해주세요', 'aria-label': '내가 싫어하는 음식' });
    const btn = el('button', { class: 'primary', type: 'button', text: '참여하기' });

    const submit = async () => {
      if (!name.value.trim()) { showError('이름을 입력해주세요'); name.focus(); return; }
      btn.disabled = true;
      btn.textContent = '참여하는 중…';
      showError(null);
      try {
        const { room, me } = await api('POST', { action: 'join', id: roomId, name: name.value, dislikes: food.value });
        state.me = me;
        persist();
        try { localStorage.setItem('menu-picker:name', name.value.trim()); } catch { /* 무시 */ }
        state.room = room;
        renderMine();
        apply(room);
      } catch (e) {
        showError(e.message);
        btn.disabled = false;
        btn.textContent = '참여하기';
      }
    };
    btn.addEventListener('click', submit);
    [name, food].forEach(i => i.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); submit(); }
    }));

    ui.meBox.append(
      el('h2', { class: 'section-title', text: '나도 참여하기' }),
      notice ? el('p', { class: 'notice', text: notice }) : null,
      el('div', { class: 'rows' }, [field('이름', name), field('싫어하는 것', food)]),
      chipsFor(food, () => {}),
      btn
    );
    ui.recommendBtn.hidden = true;
  }

  function renderMine() {
    ui.meBox.innerHTML = '';
    const mine = state.room?.participants.find(p => p.pid === state.me.pid);
    const name = el('input', { type: 'text', maxlength: String(MAX_NAME), 'aria-label': '내 이름', value: mine?.name || '' });
    const food = el('input', { type: 'text', maxlength: String(MAX_LEN), placeholder: '싫어하는 음식을 입력해주세요', 'aria-label': '내가 싫어하는 음식', value: mine?.dislikes || '' });
    const status = el('small', { text: '' });

    // 입력을 멈추면 자동 저장
    const save = async () => {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
      if (!name.value.trim()) { status.textContent = '이름을 입력해주세요'; return; }
      status.textContent = '저장 중…';
      try {
        const { room } = await api('POST', {
          action: 'update', id: roomId, pid: state.me.pid, token: state.me.token,
          name: name.value, dislikes: food.value
        });
        status.textContent = '저장됐어요';
        showError(null);
        apply(room);
      } catch (e) {
        status.textContent = '';
        if (e.status === 403) return handleRemoved();
        showError(e.message);
      }
    };
    state.flushSave = save;
    const queueSave = () => {
      status.textContent = '입력 중…';
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(save, 700);
    };
    [name, food].forEach(i => {
      i.addEventListener('input', queueSave);
      i.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); save(); }
      });
    });

    const leave = el('button', {
      class: 'text-btn', type: 'button', text: '이 방에서 나가기',
      onclick: async () => {
        if (!confirm('이 방에서 나갈까요? 내가 적은 내용도 같이 지워져요.')) return;
        try {
          const { room } = await api('POST', { action: 'remove', id: roomId, pid: state.me.pid, token: state.me.token });
          state.me = null;
          persist();
          renderJoin();
          apply(room);
        } catch (e) {
          showError(e.message);
        }
      }
    });

    ui.meBox.append(
      el('h2', { class: 'section-title' }, [document.createTextNode('내가 적은 것'), status]),
      el('div', { class: 'rows' }, [field('이름', name), field('싫어하는 것', food)]),
      chipsFor(food, queueSave),
      el('div', { class: 'leave' }, [leave])
    );
    ui.recommendBtn.hidden = false;
  }

  function handleRemoved() {
    state.me = null;
    persist();
    renderJoin('목록에서 빠졌어요. 다시 참여하려면 이름을 입력해주세요.');
  }

  /* ---------------- 참여자 목록, 옵션, 진행 상태 ---------------- */

  function renderPeople(room) {
    const list = room.participants;
    ui.peopleTitle.textContent = `참여한 사람 ${list.length}명`;
    ui.people.innerHTML = '';
    if (!list.length) {
      ui.people.append(el('li', { class: 'empty-people', text: '아직 아무도 없어요. 링크를 보내서 친구들을 불러보세요.' }));
      return;
    }
    list.forEach(p => {
      const isMe = state.me?.pid === p.pid;
      const who = el('div', { class: 'who' }, [
        el('span', { class: 'pname', text: p.name }),
        isMe ? el('span', { class: 'me-badge', text: '나' }) : null,
        el('p', { class: 'pfood', text: p.dislikes || '가리는 음식 없어요' })
      ]);
      const li = el('li', { class: 'person' }, [who]);
      if (state.hostToken && !isMe) {
        li.append(el('button', {
          class: 'icon-btn', type: 'button', text: '×', 'aria-label': `${p.name} 목록에서 빼기`,
          onclick: async () => {
            if (!confirm(`${p.name}님을 목록에서 뺄까요?`)) return;
            try {
              apply((await api('POST', { action: 'remove', id: roomId, pid: p.pid, hostToken: state.hostToken })).room);
            } catch (e) { showError(e.message); }
          }
        }));
      }
      ui.people.append(li);
    });
  }

  function renderOptions(room) {
    const grid = ui.opts.querySelector('.opt-grid');
    grid.innerHTML = '';
    const canEdit = Boolean(state.hostToken);
    const segment = (label, options, current, toValue) => {
      const seg = el('div', { class: 'seg', role: 'group', 'aria-label': label });
      options.forEach(o => seg.append(el('button', {
        type: 'button', text: o, 'aria-pressed': String(o === current), disabled: !canEdit,
        onclick: async () => {
          const next = { ...state.room.options, ...toValue(o) };
          try {
            apply((await api('POST', { action: 'options', id: roomId, hostToken: state.hostToken, options: next })).room);
          } catch (e) { showError(e.message); }
        }
      })));
      return el('div', { class: 'opt' }, [el('span', { text: label }), seg]);
    };
    grid.append(
      segment('식사 시간', ['점심', '저녁'], room.options.meal, v => ({ meal: v })),
      segment('술', ['안 마셔요', '마실 거예요'], room.options.alcohol ? '마실 거예요' : '안 마셔요', v => ({ alcohol: v === '마실 거예요' }))
    );
    if (!canEdit) grid.append(el('p', { class: 'hint', text: '식사 옵션은 방을 만든 사람이 정할 수 있어요' }));
    ui.opts.querySelector('summary').textContent =
      `식사 옵션: ${room.options.meal}, 술 ${room.options.alcohol ? '마실 예정' : '안 마셔요'}`;
  }

  function updateButtons(room) {
    const pending = room.pending;
    const waiting = Boolean(state.waiting);
    ui.pending.hidden = !pending && !waiting;
    ui.pending.textContent = pending
      ? `${pending.by}님이 메뉴를 고르는 중이에요. 다 고르면 자동으로 보여드릴게요`
      : waiting ? '메뉴를 고르는 중이에요. 다 고르면 자동으로 보여드릴게요' : '';
    const blocked = state.busy || waiting || Boolean(pending);
    ui.recommendBtn.disabled = blocked;
    ui.recommendBtn.textContent = blocked ? '메뉴 고르는 중…' : '메뉴 추천받기';
    ui.randomBtn.disabled = blocked || !state.me;
    ui.resultCard.querySelectorAll('.actions button').forEach(b => { b.disabled = blocked || !state.me; });
  }

  /* ---------------- 결과 ---------------- */

  // 결과가 나온 뒤에 누군가 입력을 바꾸거나 새로 들어왔는지 확인
  function isStale(room) {
    const snap = room.result?.people;
    if (!snap) return false;
    const key = list => list.map(p => `${p.name}:${p.dislikes}`).sort().join('|');
    return key(snap) !== key(room.participants);
  }

  function conditionChips(people) {
    const chips = people.flatMap(p => items(p.dislikes).map(item => `${p.name} ${item} 뺌`));
    if (!chips.length) return null;
    return el('div', { class: 'avoid center' }, chips.map(c => el('span', { text: c })));
  }

  function resultActions(primary) {
    const again = el('button', { class: 'secondary', type: 'button', text: '다른 메뉴 보기' });
    again.addEventListener('click', () => recommend('list', again));
    const spin = el('button', { class: 'secondary', type: 'button', text: primary === 'random' ? '다시 뽑기' : '이 중에서 하나 뽑기' });
    spin.addEventListener('click', () => recommend('respin', spin));
    return el('div', { class: 'actions' }, primary === 'random' ? [spin, again] : [again, spin]);
  }

  function renderResult(room) {
    const r = room.result;
    if (!r) { ui.resultCard.hidden = true; return; }
    const isNew = r.id !== state.lastResultId;
    const meta = ui.resultCard.querySelector('[data-meta]');
    const stale = ui.resultCard.querySelector('[data-stale]');

    // 같은 결과면 "몇 분 전"과 변경 안내만 갱신 (룰렛 애니메이션이 끊기지 않도록)
    if (!isNew && meta) {
      meta.textContent = `${r.by}님이 ${timeAgo(r.createdAt)} 골랐어요`;
      stale.hidden = !isStale(room);
      return;
    }
    const animate = !state.firstRender && r.mode === 'random' && !reduceMotion;
    state.lastResultId = r.id;
    ui.resultCard.hidden = false;
    ui.resultCard.innerHTML = '';

    const wrap = el('div', { class: 'reveal' });
    const metaLine = el('p', { 'data-meta': '', text: `${r.by}님이 ${timeAgo(r.createdAt)} 골랐어요` });
    const staleLine = el('p', { class: 'stale', 'data-stale': '', text: '결과가 나온 뒤에 입력이 바뀌었어요. 다시 추천받아 보세요.', hidden: !isStale(room) });

    if (r.mode === 'random' && Number.isInteger(r.pick)) {
      const final = r.menus[r.pick] || r.menus[0];
      const label = el('p', { class: 'label', text: animate ? '고르는 중…' : '오늘은 이거 어때요?' });
      const name = el('p', { class: 'name', text: animate ? '' : final.name });
      const desc = el('p', { class: 'desc', text: animate ? '' : final.reason });
      const slot = el('div', { class: animate ? 'slot' : 'slot landed' }, [label, name, desc]);
      const chips = conditionChips(r.people || []);
      wrap.append(slot, el('div', { class: 'result-head' }, [metaLine, staleLine, chips]), resultActions('random'));

      if (animate) {
        let tick = 0;
        const step = () => {
          tick++;
          name.textContent = r.menus[tick % r.menus.length].name;
          if (tick >= 14) {
            slot.classList.add('landed');
            label.textContent = '오늘은 이거 어때요?';
            name.textContent = final.name;
            desc.textContent = final.reason;
            return;
          }
          setTimeout(step, 50 + tick * 12);
        };
        step();
      }
    } else {
      wrap.append(
        el('div', { class: 'result-head' }, [
          el('h2', { text: '이 메뉴라면 다 같이 먹을 수 있어요' }),
          metaLine, conditionChips(r.people || []), staleLine
        ]),
        el('ul', { class: 'menus' }, r.menus.map(m => el('li', { class: 'menu' }, [
          el('div', { class: 'top' }, [el('h3', { text: m.name }), m.category ? el('span', { class: 'cat', text: m.category }) : null]),
          el('p', { text: m.reason })
        ]))),
        resultActions('list')
      );
    }
    ui.resultCard.append(wrap);
  }

  /* ---------------- 상태 반영과 자동 새로고침 ---------------- */

  function apply(room) {
    // 늦게 도착한 예전 응답이 최신 상태를 덮어쓰지 않도록 무시
    if (room.version < state.renderedVersion) return;
    state.room = room;

    if (state.me && !room.participants.some(p => p.pid === state.me.pid)) handleRemoved();

    if (room.version !== state.renderedVersion) {
      state.renderedVersion = room.version;
      renderPeople(room);
      renderOptions(room);
    }
    renderResult(room);
    checkWaiting(room);
    updateButtons(room);
    state.firstRender = false;
  }

  function scrollToResult() {
    ui.resultCard.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  function startWaiting(prevResultId) {
    state.waiting = { since: Date.now(), prevResultId };
    showError(null);
    if (state.room) updateButtons(state.room);
    poll();
  }

  function checkWaiting(room) {
    const w = state.waiting;
    if (!w) return;
    const elapsed = Date.now() - w.since;
    if (room.result && room.result.id !== w.prevResultId) {
      state.waiting = null;          // 새 결과 도착
      scrollToResult();
    } else if ((!room.pending && elapsed > 3000) || elapsed > WAIT_LIMIT_MS) {
      state.waiting = null;          // 고르던 게 끝났는데 새 결과가 없음 = 실패
      showError('메뉴를 고르지 못했어요. 잠시 후 다시 눌러주세요');
    }
  }

  async function poll() {
    clearTimeout(state.pollTimer);
    if (document.visibilityState === 'visible') {
      try {
        apply((await api('GET')).room);
      } catch (e) {
        if (e.status === 404) return showExpired();
      }
    }
    const fast = state.waiting || state.room?.pending;
    state.pollTimer = setTimeout(poll, fast ? FAST_POLL_MS : POLL_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });

  async function recommend(mode, button) {
    if (state.busy || state.waiting) return;
    if (!state.me) { showError('먼저 이름을 적고 참여해주세요'); return; }

    // 버튼을 여러 번 눌러도 한 번만 요청되도록 저장보다 먼저 잠금
    state.busy = true;
    showError(null);
    const label = button.textContent;
    updateButtons(state.room);
    button.textContent = mode === 'respin' ? '뽑는 중…' : '메뉴 고르는 중…';
    const prevResultId = state.room?.result?.id || null;

    try {
      // 저장 대기 중인 입력이 있으면 먼저 저장해서 최신 내용으로 추천받기
      if (state.saveTimer && state.flushSave) {
        state.saveTimer = null;
        await state.flushSave();
      }
      const { room } = await api('POST', { action: 'recommend', id: roomId, pid: state.me.pid, token: state.me.token, mode });
      state.busy = false;
      apply(room);
      scrollToResult();
    } catch (e) {
      state.busy = false;
      button.textContent = label;
      if (e.status === 403) { handleRemoved(); showError(e.message); return; }

      // 이미 누군가(또는 내 이전 요청이) 고르는 중이거나, 응답만 중간에 끊긴 경우:
      // 에러로 멈추지 않고 결과가 나올 때까지 기다렸다가 자동으로 보여줌
      const inProgress = e.status === 409 || e.status === 0 || (e.gateway && e.status >= 500);
      if (inProgress && mode !== 'respin') return startWaiting(prevResultId);

      showError(e.message);
      // 화면에 남아 있는 "고르는 중" 표시를 바로 지우도록 최신 상태를 다시 받아옴
      if (state.room) updateButtons(state.room);
      poll();
    }
  }

  function showExpired() {
    clearTimeout(state.pollTimer);
    page.innerHTML = '';
    const card = el('section', { class: 'card' });
    const hero = el('div', { class: 'hero' });
    hero.append(mascot());
    hero.append(el('h1', { text: '방을 찾지 못했어요' }));
    hero.append(el('p', { text: '링크가 잘못됐거나, 48시간 동안 아무도 쓰지 않아서 사라진 방이에요' }));
    const again = el('button', { class: 'primary', type: 'button', text: '새 방 만들기' });
    again.addEventListener('click', () => createRoom(again));
    card.append(hero, again);
    page.append(card, el('div', { class: 'pills' }, [el('a', { class: 'random-link', href: '/', text: '혼자 정하기' })]));
  }

  /* ---------------- 시작 ---------------- */

  (async () => {
    try {
      const { room } = await api('GET');
      buildSkeleton();
      state.room = room;
      if (state.me && room.participants.some(p => p.pid === state.me.pid)) renderMine();
      else { state.me = null; persist(); renderJoin(); }
      apply(room);
      state.pollTimer = setTimeout(poll, POLL_MS);
    } catch (e) {
      if (e.status === 404) return showExpired();
      page.append(el('section', { class: 'card' }, [el('p', { class: 'error', text: e.message })]));
    }
  })();
})();