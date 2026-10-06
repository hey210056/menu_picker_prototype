# 다같이 뭐 먹지

싫어하는 음식을 적으면 HyperCLOVA X가 모두 먹을 수 있는 메뉴를 추천해주는 웹사이트.

## 구조
- index.html / style.css / script.js : 프론트엔드 (프로토타입 그대로)
- api/recommend.js : Vercel 서버리스 함수. CLOVA Studio API 키는 여기서만 사용
- .env : API 키 (vercel dev가 읽는 파일, GitHub에 올라가지 않음)
- vercel.json : 함수 최대 실행 시간 설정

## 로컬 실행
npm i -g vercel
vercel dev
→ http://localhost:3000

index.html을 더블클릭해서 열면 /api가 없어서 추천이 동작하지 않아요. 꼭 vercel dev로 실행하세요.

## 배포
1. GitHub에 push (.env.local은 .gitignore로 제외됨)
2. Vercel에서 저장소 Import
3. Settings → Environment Variables에 CLOVA_API_KEY, CLOVA_MODEL 등록 후 Redeploy
