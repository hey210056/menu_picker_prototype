# 다같이 뭐 먹지

싫어하는 음식을 적으면 HyperCLOVA X가 모두 먹을 수 있는 메뉴를 추천해주는 웹사이트.

- 혼자 입력: 한 명이 여러 사람의 싫어하는 음식을 대신 적기
- 링크로 같이 정하기: 방을 만들고 링크를 보내면 각자 자기 휴대폰에서 입력, 결과는 모두에게 똑같이 보임

## 구조
- index.html / style.css : 화면
- script.js : 혼자 입력 화면
- room.js : 링크 공유 방 화면 (주소가 /?room=방ID 일 때)
- api/recommend.js : 혼자 입력용 추천 API
- api/room.js : 링크 공유 방 API
- lib/prompt.js : 시스템 프롬프트와 생성 파라미터 (튜닝은 여기서)
- lib/menu-ai.js : 입력 검증, CLOVA Studio 호출, 응답 정리
- lib/rooms.js : 방 만들기, 참여, 수정, 추천 로직
- lib/room-store.js : 방 저장소 (기본: data/rooms.json, Upstash 설정 시 Upstash Redis)
- server.js : NCP 등 일반 서버용 Node 서버
- .env : API 키 (GitHub에 올라가지 않음)

## NCP 서버
git pull && npm install && pm2 restart menu-picker
방 데이터는 data/rooms.json에 저장되고, 마지막 활동 후 48시간이 지나면 자동으로 지워집니다.
