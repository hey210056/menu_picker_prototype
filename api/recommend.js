// Vercel 서버리스 함수: POST /api/recommend (혼자 입력하는 화면용)
// 실제 추천 로직은 lib/menu-ai.js, 프롬프트는 lib/prompt.js에 있어요.

import { generateMenus } from '../lib/menu-ai.js';
import { getBody, send } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'POST 요청만 받을 수 있어요' });
  }
  const { status, body } = await generateMenus(getBody(req));
  return send(res, status, body);
}
