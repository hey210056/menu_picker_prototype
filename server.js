// NCP 같은 일반 서버에서 실행하기 위한 Node 서버
// - 정적 파일(index.html, style.css, script.js)만 골라서 제공 (.env, 소스코드 등은 노출 안 됨)
// - /api/recommend 는 Vercel용으로 만든 api/recommend.js 를 그대로 재사용
// - IP별 호출 제한 포함

import dotenv from 'dotenv';
dotenv.config({ quiet: true });
import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/recommend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// 기본값은 서버 내부에서만 접속 가능 (Nginx가 앞에서 받아서 넘겨줌)
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Nginx가 넘겨주는 실제 사용자 IP를 사용

// 1) 공개할 파일만 명시적으로 등록
const PUBLIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/script.js': 'script.js'
};
for (const [route, file] of Object.entries(PUBLIC_FILES)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, file)));
}

// 2) API: IP당 1분에 10번까지
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많아요. 1분 뒤에 다시 시도해주세요' }
});

app.use('/api/recommend', limiter, express.json({ limit: '10kb' }));
app.all('/api/recommend', async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (e) {
    next(e);
  }
});

// 3) 그 외 경로는 전부 404
app.use((req, res) => res.status(404).send('Not Found'));

// 4) 에러 처리
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: '요청 형식이 올바르지 않아요' });
  }
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했어요' });
});

app.listen(PORT, HOST, () => {
  console.log(`menu-picker 실행 중: http://${HOST}:${PORT}`);
});
