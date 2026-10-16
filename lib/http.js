// Vercel 함수와 Express(server.js)에서 같이 쓰는 요청 처리 도구

export function getBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  return body && typeof body === 'object' ? body : null;
}

// x-real-ip는 Nginx(NCP)와 Vercel이 직접 넣어주는 값이라 사용자가 조작할 수 없어서 우선 사용
export function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',').pop().trim();
  return req.socket?.remoteAddress || 'unknown';
}

// 간단한 호출 제한 (서버 메모리 사용)
// NCP처럼 서버 한 대에서는 정확하게, Vercel에서는 인스턴스마다 따로 세서 대략적으로 동작합니다.
const hits = new Map();
const WINDOW_MS = 60 * 1000;

export function isRateLimited(bucket, ip, limit) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, times] of hits) {
      if (!times.some(t => now - t < WINDOW_MS)) hits.delete(k);
    }
  }
  return recent.length > limit;
}

export function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}
