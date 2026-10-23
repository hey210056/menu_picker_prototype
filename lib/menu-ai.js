// 메뉴 추천 핵심 로직 (서버 전용)
// /api/recommend(혼자 입력)와 /api/room(링크 공유) 두 곳에서 같이 사용합니다.
// CLOVA Studio API 키는 여기서만 읽으며 브라우저로 전달되지 않습니다.

import { CATEGORIES, GENERATION, MAIN_CATEGORIES, MODEL_SETTINGS, SYSTEM_PROMPT } from './prompt.js';

const BASE_URL = process.env.CLOVA_BASE_URL || 'https://clovastudio.stream.ntruss.com';
const MODEL = process.env.CLOVA_MODEL || 'HCX-005';
const ENDPOINT = `${BASE_URL}/v3/chat-completions/${MODEL}`;
// 목록에 없는 모델 이름이면 HCX-005 방식(maxTokens)으로 요청
const { timeoutMs: TIMEOUT_MS, ...MODEL_PARAMS } = MODEL_SETTINGS[MODEL] || MODEL_SETTINGS['HCX-005'];
// 재시도까지 포함한 전체 제한 시간 (Vercel 함수 제한 60초 안에 끝나도록)
const TOTAL_MS = 55000;

export const MAX_PEOPLE = 10;
export const MAX_LEN = 100;
export const MAX_NAME = 12;
export const MAX_COUNT = 5;
export const MAX_EXCLUDE = 15;
export const MAX_ALLERGY = 60;
export const MEALS = ['아침', '점심', '저녁'];
export const BUDGETS = ['1만원 이하', '1~2만원', '2~3만원', '3만원 이상', '상관없어요'];
export const SPLIT = /[,，、\/·]+/;

export function splitItems(text) {
  return [...new Set(String(text || '').split(SPLIT).map(s => s.trim()).filter(Boolean))];
}

export function validate(body) {
  if (!body || typeof body !== 'object') return '요청 형식이 올바르지 않아요';
  const { people, options, count, exclude } = body;
  if (!Array.isArray(people) || people.length > MAX_PEOPLE) {
    return `인원은 최대 ${MAX_PEOPLE}명까지 가능해요`;
  }
  for (const p of people) {
    if (!p || !Number.isInteger(p.id) || p.id < 1 || p.id > MAX_PEOPLE) return '참가자 정보가 올바르지 않아요';
    if (typeof p.dislikes !== 'string' || p.dislikes.length > MAX_LEN) {
      return `한 사람당 ${MAX_LEN}자까지 입력할 수 있어요`;
    }
    if (p.label !== undefined && (typeof p.label !== 'string' || p.label.length > MAX_NAME)) {
      return '참가자 이름이 올바르지 않아요';
    }
    if (p.allergy !== undefined && (typeof p.allergy !== 'string' || p.allergy.length > MAX_ALLERGY)) {
      return `알레르기는 ${MAX_ALLERGY}자까지 입력할 수 있어요`;
    }
  }
  if (!options || !MEALS.includes(options.meal) || typeof options.alcohol !== 'boolean') {
    return '식사 옵션이 올바르지 않아요';
  }
  if (options.budget !== undefined && !BUDGETS.includes(options.budget)) {
    return '금액대가 올바르지 않아요';
  }
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_COUNT)) {
    return '추천 개수가 올바르지 않아요';
  }
  if (exclude !== undefined && (
    !Array.isArray(exclude) || exclude.length > MAX_EXCLUDE ||
    exclude.some(n => typeof n !== 'string' || n.length > 40)
  )) {
    return '제외 목록이 올바르지 않아요';
  }
  return null;
}

function pickCategories(count) {
  const pool = [...MAIN_CATEGORIES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

// 시스템 프롬프트의 [입력 형식]에 맞춰 필드 이름 그대로 JSON으로 전달합니다.
// (participants, mealTime, alcohol, budget, recommendationCount, assignments, previousMenus)
// 링크 공유 방에서는 "1번" 대신 참가자 이름(label)을 씁니다.
function buildUserMessage({ people, options, exclude = [] }, count) {
  const input = {
    participants: people.map(p => ({
      name: p.label || `${p.id}번`,
      restrictions: [
        ...splitItems(p.dislikes),
        ...splitItems(p.allergy).map(a => `알레르기: ${a}`)
      ]
    })),
    mealTime: options.meal,
    alcohol: options.alcohol ? '마실 예정' : '마시지 않음',
    recommendationCount: count,
    assignments: pickCategories(count),
    previousMenus: exclude
  };
  // "상관없어요"면 필드를 아예 빼서 가격을 고려하지 않게 함
  if (options.budget && options.budget !== '상관없어요') input.budget = options.budget;
  return JSON.stringify(input, null, 2);
}

// 모델 답변에서 JSON만 꺼내서 화면에 필요한 형태로 정리
// {"menus": [...]} 형태와 [...] 배열 형태를 모두 받아줌
// 반환값: 메뉴 배열 / 빈 배열(모델이 "맞는 메뉴 없음"이라고 답함) / null(형식이 깨짐)
function parseMenus(content) {
  const text = Array.isArray(content)
    ? content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('')
    : String(content || '');
  const cleaned = text.replace(/```json|```/g, '').trim();

  const starts = [cleaned.indexOf('['), cleaned.indexOf('{')].filter(i => i !== -1);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = cleaned.lastIndexOf(cleaned[start] === '[' ? ']' : '}');
  if (end <= start) return null;

  let parsed;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  const list = Array.isArray(parsed) ? parsed : parsed?.menus;
  if (!Array.isArray(list)) return null;

  return list
    .filter(m => m && typeof m.name === 'string' && m.name.trim())
    .slice(0, MAX_COUNT)
    .map(m => {
      const category = typeof m.category === 'string' ? m.category.trim() : '';
      return {
        name: m.name.trim().slice(0, 40),
        // "일식/아시안"처럼 섞여 오면 앞쪽 분류를 사용
        category: CATEGORIES.find(c => category.includes(c)) || '기타',
        reason: typeof m.reason === 'string' ? m.reason.trim().slice(0, 300) : ''
      };
    });
}

// 안전장치: 메뉴 이름에 싫어하는 음식이 그대로 들어 있거나(예: "오이" → "오이냉국"),
// 이미 추천한 메뉴가 다시 나오면 서버에서 한 번 더 걸러냄
function postFilter(menus, { people, exclude = [] }) {
  const words = people
    .flatMap(p => [...p.dislikes.split(SPLIT), ...String(p.allergy || '').split(SPLIT)])
    .map(w => w.trim())
    .filter(w => w.length >= 2);
  const seen = new Set(exclude.map(n => n.replace(/\s/g, '')));
  const picked = new Set();
  return menus.filter(m => {
    const key = m.name.replace(/\s/g, '');
    if (seen.has(key) || picked.has(key)) return false;
    if (words.some(w => m.name.includes(w))) return false;
    picked.add(key);
    return true;
  });
}

async function callClova(apiKey, userMessage, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-NCP-CLOVASTUDIO-REQUEST-ID': crypto.randomUUID(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
          { role: 'user', content: [{ type: 'text', text: userMessage }] }
        ],
        ...GENERATION,
        ...MODEL_PARAMS
      })
    });
    const data = await res.json().catch(() => null);
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

const fail = (status, error) => ({ status, body: { error } });

// 결과: { status: 200, body: { menus } } 또는 { status: 4xx/5xx, body: { error } }
export async function generateMenus(request) {
  const apiKey = process.env.CLOVA_API_KEY;
  if (!apiKey) return fail(500, '서버에 API 키가 설정되지 않았어요');

  const invalid = validate(request);
  if (invalid) return fail(400, invalid);

  const count = request.count || 3;
  const userMessage = buildUserMessage(request, count);

  // CLOVA 호출. 답변 형식이 깨졌을 때만 한 번 더 시도
  let menus = null;
  const deadline = Date.now() + TOTAL_MS;
  for (let attempt = 1; attempt <= 2 && menus === null; attempt++) {
    const remaining = deadline - Date.now();
    if (attempt > 1 && remaining < 10000) break; // 다시 시도할 시간이 부족하면 중단
    let result;
    try {
      result = await callClova(apiKey, userMessage, Math.min(TIMEOUT_MS, remaining));
    } catch (e) {
      console.error('CLOVA 연결 실패:', e);
      return fail(504, '추천 서버 응답이 늦어요. 잠시 후 다시 시도해주세요');
    }
    const { res, data } = result;

    // 성공 응답: { status: { code: "20000" }, result: { message: { content } } }
    if (!res.ok || data?.status?.code !== '20000') {
      console.error('CLOVA 오류:', res.status, JSON.stringify(data));
      if (res.status === 401) return fail(500, 'API 키 설정을 확인해주세요');
      if (res.status === 429) return fail(429, '요청이 많아요. 잠시 후 다시 시도해주세요');
      return fail(502, '메뉴 추천에 실패했어요. 잠시 후 다시 시도해주세요');
    }

    menus = parseMenus(data?.result?.message?.content);
    if (menus === null) console.warn(`응답 파싱 실패 (${attempt}회차):`, JSON.stringify(data, null, 2));
  }

  if (menus === null) return fail(502, '추천 결과를 읽지 못했어요. 다시 시도해주세요');

  // 서버 쪽 안전장치로 한 번 더 거르고 요청한 개수만큼 반환
  const filtered = postFilter(menus, request).slice(0, count);
  if (!filtered.length) {
    console.warn('맞는 메뉴 없음:', JSON.stringify(menus));
    return fail(422, '조건에 맞는 메뉴를 찾지 못했어요. 다시 시도하거나 싫어하는 음식을 조금 줄여보세요');
  }
  return { status: 200, body: { menus: filtered } };
}
