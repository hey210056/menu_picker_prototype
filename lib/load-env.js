// server.js에서 가장 먼저 불러와서 .env를 읽음 (다른 모듈보다 먼저 실행되도록 분리)
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
