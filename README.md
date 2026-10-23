# 다같이 뭐 먹지

싫어하는 음식을 적으면 HyperCLOVA X가 모두 먹을 수 있는 메뉴를 추천해주는 웹사이트.

- 혼자 입력: 한 명이 여러 사람의 싫어하는 음식을 대신 적기
- 링크로 같이 정하기: 방을 만들고 링크를 보내면 각자 자기 휴대폰에서 입력, 결과는 모두에게 똑같이 보임

## 구조
- index.html / style.css / app.js : 화면 (Figma 디자인 기준)
  스플래시 → 첫 화면 → ① 못 먹는 음식 → ② 어떤 식사 → 추천 중 → 오늘의 후보 → 메뉴 확정
- assets/ : 이미지와 아이콘 (pig.png, logo.png는 Figma에서 내보내서 넣기)
- api/room.js : 모임 방 API (참여, 입력 저장, 식사 옵션, 추천, 메뉴 확정)
- api/recommend.js : 방 없이 바로 추천받는 API (예전 화면용, 지금 화면은 사용 안 함)
- lib/prompt.js : 시스템 프롬프트와 생성 파라미터 (튜닝은 여기서)
- lib/menu-ai.js : 입력 검증, CLOVA Studio 호출(프롬프트의 입력 형식대로 JSON 전달), 응답 정리
- lib/rooms.js : 방 로직
- lib/room-store.js : 방 저장소 (기본: data/rooms.json, Upstash 설정 시 Upstash Redis)
- server.js : NCP 등 일반 서버용 Node 서버
- .env : API 키 (GitHub에 올라가지 않음)

## NCP 서버
git pull && npm install && pm2 restart menu-picker
방 데이터는 data/rooms.json에 저장되고, 마지막 활동 후 48시간이 지나면 자동으로 지워집니다.
