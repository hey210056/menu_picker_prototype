// 링크 공유 방 로직
// GET  /api/room?id=방ID                      → 방 상태 조회 (몇 초마다 자동으로 호출됨)
// POST /api/room { action: 'create' | 'join' | 'update' | 'remove' | 'options' | 'recommend' | 'choose', ... }

import { randomBytes } from 'node:crypto';
import { ROOM_TTL_MS, store, storeProblem } from './room-store.js';
import {
  BUDGETS, generateMenus, MAX_ALLERGY, MAX_EXCLUDE, MAX_LEN, MAX_NAME, MAX_PEOPLE, MEALS, splitItems
} from './menu-ai.js';
import { clientIp, getBody, isRateLimited, send } from './http.js';

const ROOM_ID = /^[A-Za-z0-9]{10}$/;
const PID = /^[A-Za-z0-9]{8}$/;
const LOCK_MS = 90 * 1000; // AI 응답(재시도 포함)이 끝날 때까지 다른 사람의 추천 요청을 막는 시간
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// 액션별 IP당 1분 호출 한도
// 같은 와이파이의 친구들은 IP가 같으니 조회(get)는 여유 있게 둠 (한 명당 4초마다 조회)
const LIMITS = { get: 600, create: 5, join: 20, update: 120, remove: 20, options: 60, recommend: 10, choose: 30 };
const DEFAULT_OPTIONS = { meal: '저녁', alcohol: false, budget: '상관없어요' };

function randomId(length) {
  const bytes = randomBytes(length);
  return [...bytes].map(b => BASE62[b % 62]).join('');
}
const randomToken = () => randomBytes(24).toString('base64url');

function cleanName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\[\]{}<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

function cleanDislikes(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f]/g, ' ');
  return splitItems(text).join(', ').slice(0, MAX_LEN);
}

function cleanAllergy(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f]/g, ' ');
  return splitItems(text).join(', ').slice(0, MAX_ALLERGY);
}

function cleanOptions(o) {
  if (!o || !MEALS.includes(o.meal) || typeof o.alcohol !== 'boolean') return null;
  const budget = BUDGETS.includes(o.budget) ? o.budget : '상관없어요';
  return { meal: o.meal, alcohol: o.alcohol, budget };
}

const sortedPeople = room =>
  Object.values(room.participants || {}).sort((a, b) => a.joinedAt - b.joinedAt);

// 브라우저에 보낼 때는 토큰을 모두 빼고 보냄
function publicRoom(room) {
  const pending = room.pending && Date.now() - room.pending.since < LOCK_MS ? room.pending : null;
  return {
    id: room.id,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    version: room.version,
    options: { ...DEFAULT_OPTIONS, ...room.options },
    participants: sortedPeople(room).map(({ pid, name, dislikes, allergy, joinedAt, updatedAt }) => ({
      pid, name, dislikes, allergy: allergy || '', joinedAt, updatedAt
    })),
    result: room.result || null,
    pending
  };
}

const nameTaken = (room, name, exceptPid) =>
  sortedPeople(room).some(p => p.pid !== exceptPid && p.name.toLowerCase() === name.toLowerCase());

async function loadRoom(id) {
  if (typeof id !== 'string' || !ROOM_ID.test(id)) return null;
  return store.get(id);
}

function authParticipant(room, pid, token) {
  if (typeof pid !== 'string' || !PID.test(pid) || typeof token !== 'string') return null;
  const p = room.participants?.[pid];
  return p && p.token === token ? p : null;
}

/* ---------------- 액션 ---------------- */

async function create(body) {
  const options = cleanOptions(body.options) || { ...DEFAULT_OPTIONS };
  const now = Date.now();
  const room = {
    id: randomId(10),
    createdAt: now,
    expiresAt: now + ROOM_TTL_MS,
    hostToken: randomToken(),
    options,
    participants: {},
    result: null,
    seen: [],
    pending: null,
    version: 0
  };
  try {
    await store.create(room);
  } catch (e) {
    if (e.message === 'ROOM_LIMIT') return [503, { error: '지금은 방을 만들 수 없어요. 잠시 후 다시 시도해주세요' }];
    throw e;
  }
  const saved = await store.get(room.id);
  return [200, { room: publicRoom(saved), hostToken: room.hostToken }];
}

async function join(room, body) {
  const name = cleanName(body.name);
  if (!name) return [400, { error: '이름을 입력해주세요' }];
  if (typeof body.dislikes !== 'string' || body.dislikes.length > MAX_LEN) {
    return [400, { error: `싫어하는 음식은 ${MAX_LEN}자까지 입력할 수 있어요` }];
  }
  if (sortedPeople(room).length >= MAX_PEOPLE) return [409, { error: `한 방에는 ${MAX_PEOPLE}명까지 참여할 수 있어요` }];
  if (nameTaken(room, name)) return [409, { error: '같은 이름이 이미 있어요. 다른 이름을 써주세요' }];

  if (body.allergy !== undefined && (typeof body.allergy !== 'string' || body.allergy.length > MAX_ALLERGY)) {
    return [400, { error: `알레르기는 ${MAX_ALLERGY}자까지 입력할 수 있어요` }];
  }

  const now = Date.now();
  const p = {
    pid: randomId(8), token: randomToken(), name,
    dislikes: cleanDislikes(body.dislikes), allergy: cleanAllergy(body.allergy),
    joinedAt: now, updatedAt: now
  };
  await store.setParticipant(room.id, p);
  return [200, { room: publicRoom(await store.get(room.id)), me: { pid: p.pid, token: p.token } }];
}

async function update(room, body) {
  const me = authParticipant(room, body.pid, body.token);
  if (!me) return [403, { error: '이 방에 참여한 기록을 찾지 못했어요. 다시 참여해주세요' }];

  const next = { ...me, updatedAt: Date.now() };
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return [400, { error: '이름을 입력해주세요' }];
    if (nameTaken(room, name, me.pid)) return [409, { error: '같은 이름이 이미 있어요. 다른 이름을 써주세요' }];
    next.name = name;
  }
  if (body.dislikes !== undefined) {
    if (typeof body.dislikes !== 'string' || body.dislikes.length > MAX_LEN) {
      return [400, { error: `싫어하는 음식은 ${MAX_LEN}자까지 입력할 수 있어요` }];
    }
    next.dislikes = cleanDislikes(body.dislikes);
  }
  if (body.allergy !== undefined) {
    if (typeof body.allergy !== 'string' || body.allergy.length > MAX_ALLERGY) {
      return [400, { error: `알레르기는 ${MAX_ALLERGY}자까지 입력할 수 있어요` }];
    }
    next.allergy = cleanAllergy(body.allergy);
  }
  await store.setParticipant(room.id, next);
  return [200, { room: publicRoom(await store.get(room.id)) }];
}

// 본인이 나가거나, 방을 만든 사람이 다른 참가자를 뺄 때
async function remove(room, body) {
  const target = typeof body.pid === 'string' ? room.participants?.[body.pid] : null;
  if (!target) return [404, { error: '참가자를 찾지 못했어요' }];
  const isSelf = typeof body.token === 'string' && body.token === target.token;
  const isHost = typeof body.hostToken === 'string' && body.hostToken === room.hostToken;
  if (!isSelf && !isHost) return [403, { error: '권한이 없어요' }];
  await store.deleteParticipant(room.id, target.pid);
  return [200, { room: publicRoom(await store.get(room.id)) }];
}

// 식사 옵션은 방을 만든 사람이나 참여한 사람 누구나 바꿀 수 있음
async function setOptions(room, body) {
  const isHost = typeof body.hostToken === 'string' && body.hostToken === room.hostToken;
  if (!isHost && !authParticipant(room, body.pid, body.token)) {
    return [403, { error: '먼저 이 방에 참여해주세요' }];
  }
  const options = cleanOptions(body.options);
  if (!options) return [400, { error: '식사 옵션이 올바르지 않아요' }];
  await store.patch(room.id, { options });
  return [200, { room: publicRoom(await store.get(room.id)) }];
}

async function recommend(room, body) {
  const me = authParticipant(room, body.pid, body.token);
  if (!me) return [403, { error: '먼저 이 방에 참여해주세요' }];
  const mode = body.mode;
  if (!['list', 'random', 'respin'].includes(mode)) return [400, { error: '요청 형식이 올바르지 않아요' }];

  // 다시 뽑기: 이미 받은 후보 안에서만 다시 고르므로 AI를 호출하지 않음
  if (mode === 'respin') {
    const prev = room.result;
    if (!prev?.menus?.length) return [400, { error: '먼저 메뉴를 추천받아 주세요' }];
    let pick = Math.floor(Math.random() * prev.menus.length);
    if (prev.menus.length > 1 && pick === prev.pick) pick = (pick + 1) % prev.menus.length;
    const result = { ...prev, id: randomId(8), mode: 'random', pick, by: me.name, createdAt: Date.now() };
    await store.patch(room.id, { result });
    return [200, { room: publicRoom(await store.get(room.id)) }];
  }

  // 여러 명이 동시에 눌러도 AI는 한 번만 호출되도록 잠금
  if (!(await store.tryLock(room.id, LOCK_MS))) {
    const by = room.pending?.by;
    return [409, { error: by ? `${by}님이 메뉴를 고르는 중이에요. 잠시만 기다려주세요` : '메뉴를 고르는 중이에요. 잠시만 기다려주세요' }];
  }

  try {
    await store.patch(room.id, { pending: { by: me.name, since: Date.now() } });

    // 가리는 음식이 없는 사람도 인원수에 포함되도록 모두 보냄
    const people = sortedPeople(room)
      .map((p, i) => ({ id: i + 1, label: p.name, dislikes: p.dislikes || '', allergy: p.allergy || '' }));
    const count = mode === 'random' ? 5 : 3;
    const seen = Array.isArray(room.seen) ? room.seen : [];
    const { status, body: out } = await generateMenus({
      people,
      options: room.options,
      count,
      exclude: seen.slice(-MAX_EXCLUDE)
    });

    if (status !== 200) {
      await store.patch(room.id, { pending: null });
      return [status, out];
    }

    const menus = out.menus;
    const result = {
      id: randomId(8),
      mode,
      menus,
      pick: mode === 'random' ? Math.floor(Math.random() * menus.length) : null,
      by: me.name,
      createdAt: Date.now(),
      // 어떤 조건으로 고른 결과인지 화면에 보여주고, 이후 입력이 바뀌었는지 비교하는 용도
      people: sortedPeople(room).map(p => ({ name: p.name, dislikes: p.dislikes, allergy: p.allergy || '' })),
      options: { ...DEFAULT_OPTIONS, ...room.options },
      chosen: null
    };
    const nextSeen = [...new Set([...seen, ...menus.map(m => m.name)])].slice(-MAX_EXCLUDE);
    await store.patch(room.id, { result, seen: nextSeen, pending: null });
    return [200, { room: publicRoom(await store.get(room.id)) }];
  } catch (e) {
    await store.patch(room.id, { pending: null }).catch(() => {});
    throw e;
  } finally {
    await store.unlock(room.id).catch(() => {});
  }
}

// 후보 중 하나를 "이 메뉴로 정하기" (index: null이면 확정 취소)
async function choose(room, body) {
  const me = authParticipant(room, body.pid, body.token);
  if (!me) return [403, { error: '먼저 이 방에 참여해주세요' }];
  const r = room.result;
  if (!r?.menus?.length) return [400, { error: '먼저 메뉴를 추천받아 주세요' }];
  const index = body.index;
  if (index !== null && (!Number.isInteger(index) || index < 0 || index >= r.menus.length)) {
    return [400, { error: '요청 형식이 올바르지 않아요' }];
  }
  const result = { ...r, chosen: index, chosenBy: index === null ? null : me.name, chosenAt: Date.now() };
  await store.patch(room.id, { result });
  return [200, { room: publicRoom(await store.get(room.id)) }];
}

/* ---------------- 요청 처리 ---------------- */

export async function handleRoom(req, res) {
  const problem = storeProblem();
  if (problem) return send(res, 503, { error: problem });

  const ip = clientIp(req);
  try {
    if (req.method === 'GET') {
      if (isRateLimited('room-get', ip, LIMITS.get)) return send(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해주세요' });
      const id = req.query?.id ?? new URL(req.url, 'http://x').searchParams.get('id');
      const room = await loadRoom(id);
      if (!room) return send(res, 404, { error: '방을 찾지 못했어요. 링크가 만료됐거나 잘못된 주소예요' });
      return send(res, 200, { room: publicRoom(room) });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, { error: 'GET 또는 POST 요청만 받을 수 있어요' });
    }

    const body = getBody(req);
    const action = body?.action;
    if (!body || !Object.hasOwn(LIMITS, action) || action === 'get') {
      return send(res, 400, { error: '요청 형식이 올바르지 않아요' });
    }
    if (isRateLimited(`room-${action}`, ip, LIMITS[action])) {
      return send(res, 429, { error: '요청이 너무 많아요. 1분 뒤에 다시 시도해주세요' });
    }

    if (action === 'create') {
      const [status, out] = await create(body);
      return send(res, status, out);
    }

    const room = await loadRoom(body.id);
    if (!room) return send(res, 404, { error: '방을 찾지 못했어요. 링크가 만료됐거나 잘못된 주소예요' });

    const actions = { join, update, remove, options: setOptions, recommend, choose };
    const [status, out] = await actions[action](room, body);
    return send(res, status, out);
  } catch (e) {
    console.error('방 처리 오류:', e);
    return send(res, 500, { error: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요' });
  }
}
