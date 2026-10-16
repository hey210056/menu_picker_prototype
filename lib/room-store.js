// 링크 공유 방 저장소
// - 기본: 서버 메모리 + data/rooms.json 파일 (NCP처럼 서버 한 대에서 실행할 때)
// - Upstash Redis 환경변수가 있으면 Upstash 사용 (Vercel처럼 요청마다 서버가 바뀌는 환경)
//
// 방 기록 형태:
// { id, createdAt, expiresAt, hostToken, options, participants: { [pid]: {...} },
//   result, seen, pending, version }

import fs from 'node:fs';
import path from 'node:path';

export const ROOM_TTL_MS = 48 * 60 * 60 * 1000; // 마지막 활동 후 48시간 뒤 자동 삭제

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const useUpstash = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

// Vercel은 요청마다 다른 서버에서 실행될 수 있어 메모리 저장소로는 방이 사라질 수 있음
export function storeProblem() {
  if (!useUpstash && process.env.VERCEL) {
    return 'Vercel에서 링크 공유 방을 쓰려면 Upstash Redis 연결이 필요해요';
  }
  return null;
}

/* ---------------- 메모리 + 파일 저장소 ---------------- */

const DATA_FILE = process.env.ROOM_DATA_FILE || path.join(process.cwd(), 'data', 'rooms.json');
const MAX_ROOMS = 3000;
const rooms = new Map();
const locks = new Map();
let saveTimer = null;

function loadFromFile() {
  try {
    const list = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const now = Date.now();
    for (const r of list) if (r?.id && r.expiresAt > now) rooms.set(r.id, r);
  } catch {
    // 파일이 없거나 깨졌으면 빈 상태로 시작
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...rooms.values()]), { mode: 0o600 });
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('방 저장 실패:', e);
    }
  }, 500);
}

function purgeExpired() {
  const now = Date.now();
  let removed = false;
  for (const [id, r] of rooms) {
    if (r.expiresAt <= now) { rooms.delete(id); removed = true; }
  }
  if (removed) scheduleSave();
}

function touch(r) {
  r.version = (r.version || 0) + 1;
  r.expiresAt = Date.now() + ROOM_TTL_MS;
  scheduleSave();
}

const memoryStore = {
  async get(id) {
    const r = rooms.get(id);
    if (!r) return null;
    if (r.expiresAt <= Date.now()) { rooms.delete(id); scheduleSave(); return null; }
    return structuredClone(r);
  },
  async create(record) {
    if (rooms.size >= MAX_ROOMS) purgeExpired();
    if (rooms.size >= MAX_ROOMS) throw new Error('ROOM_LIMIT');
    rooms.set(record.id, structuredClone(record));
    scheduleSave();
  },
  async setParticipant(id, p) {
    const r = rooms.get(id);
    if (!r) return;
    r.participants[p.pid] = structuredClone(p);
    touch(r);
  },
  async deleteParticipant(id, pid) {
    const r = rooms.get(id);
    if (!r) return;
    delete r.participants[pid];
    touch(r);
  },
  async patch(id, fields) {
    const r = rooms.get(id);
    if (!r) return;
    Object.assign(r, structuredClone(fields));
    touch(r);
  },
  async tryLock(id, ttlMs) {
    const until = locks.get(id);
    if (until && until > Date.now()) return false;
    locks.set(id, Date.now() + ttlMs);
    return true;
  },
  async unlock(id) {
    locks.delete(id);
  }
};

/* ---------------- Upstash Redis 저장소 (REST API, 추가 패키지 없음) ---------------- */

const roomKey = id => `mp:room:${id}`;
const peopleKey = id => `mp:room:${id}:people`;
const lockKey = id => `mp:room:${id}:lock`;
const TOP_FIELDS = ['options', 'result', 'seen', 'pending'];

async function redis(commands) {
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error(`Upstash 오류: ${res.status}`);
  const out = await res.json();
  const err = out.find(o => o.error);
  if (err) throw new Error(`Upstash 오류: ${err.error}`);
  return out.map(o => o.result);
}

const toObject = arr => {
  const obj = {};
  for (let i = 0; i < (arr || []).length; i += 2) obj[arr[i]] = arr[i + 1];
  return obj;
};

function expireCommands(id) {
  const ttl = Math.ceil(ROOM_TTL_MS / 1000);
  return [
    ['HSET', roomKey(id), 'expiresAt', String(Date.now() + ROOM_TTL_MS)],
    ['HINCRBY', roomKey(id), 'version', '1'],
    ['EXPIRE', roomKey(id), String(ttl)],
    ['EXPIRE', peopleKey(id), String(ttl)]
  ];
}

const upstashStore = {
  async get(id) {
    const [room, people] = await redis([['HGETALL', roomKey(id)], ['HGETALL', peopleKey(id)]]);
    const r = toObject(room);
    if (!r.meta) return null;
    const meta = JSON.parse(r.meta);
    const participants = {};
    for (const [pid, json] of Object.entries(toObject(people))) participants[pid] = JSON.parse(json);
    const record = { ...meta, participants, version: Number(r.version || 0), expiresAt: Number(r.expiresAt || 0) };
    for (const f of TOP_FIELDS) record[f] = r[f] ? JSON.parse(r[f]) : null;
    return record;
  },
  async create(record) {
    const { id, createdAt, hostToken, options, result, seen, pending } = record;
    await redis([
      ['HSET', roomKey(id),
        'meta', JSON.stringify({ id, createdAt, hostToken }),
        'options', JSON.stringify(options),
        'result', JSON.stringify(result),
        'seen', JSON.stringify(seen),
        'pending', JSON.stringify(pending)],
      ...expireCommands(id)
    ]);
  },
  async setParticipant(id, p) {
    await redis([['HSET', peopleKey(id), p.pid, JSON.stringify(p)], ...expireCommands(id)]);
  },
  async deleteParticipant(id, pid) {
    await redis([['HDEL', peopleKey(id), pid], ...expireCommands(id)]);
  },
  async patch(id, fields) {
    const args = Object.entries(fields)
      .filter(([k]) => TOP_FIELDS.includes(k))
      .flatMap(([k, v]) => [k, JSON.stringify(v)]);
    if (!args.length) return;
    await redis([['HSET', roomKey(id), ...args], ...expireCommands(id)]);
  },
  async tryLock(id, ttlMs) {
    const [ok] = await redis([['SET', lockKey(id), '1', 'NX', 'PX', String(ttlMs)]]);
    return ok === 'OK';
  },
  async unlock(id) {
    await redis([['DEL', lockKey(id)]]);
  }
};

if (!useUpstash) {
  loadFromFile();
  setInterval(purgeExpired, 10 * 60 * 1000).unref();
}

export const store = useUpstash ? upstashStore : memoryStore;
export const storeKind = useUpstash ? 'upstash' : 'memory';
