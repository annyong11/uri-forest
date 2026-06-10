# 우리숲 (uri-forest)

고립·은둔 청년을 위한 **회복 동물 테스트 + 맞춤 문화 추천** 웹앱.
16문항으로 사용자를 군(群) + 동물유형(3축)으로 분류하고, 5.8만 건 문화 자원 DB에서 성향·지역·조건에 맞는 장소/프로그램을 추천합니다.

🌐 **Live: https://uriforest.com**

## 스택

**Cloudflare Workers (Static Assets) + D1.** 하나의 Worker가 정적 페이지(`public/index.html`)를 서빙하고, 같은 Worker가 `/api/recommend`를 처리하며 D1을 조회합니다. (Pages 아님 — Cloudflare 신규 권장 구성.)

## 구조

```
public/index.html   프론트엔드 (vanilla HTML/CSS/JS, 빌드 없음). 설문→분류→추천 UI
src/index.js        Worker. /api/recommend = 추천 엔진, 그 외는 정적자산 폴백
db/schema.sql       D1 테이블 + 인덱스 (대리키 row_id, 파생컬럼, 부분 인덱스)
db/data.sql         58,906행 INSERT (gitignore됨 — 아래 스크립트로 생성)
scripts/csv_to_sql.py   data/*.csv → db/data.sql (positional join)
data/*.csv          원본 Solution Master DB + 선호도 브릿지 테이블
wrangler.jsonc      Worker + Static Assets + D1 바인딩 설정
DEPLOY.md           배포 런북 (D1 생성·적재·배포·커스텀 도메인)
```

## 추천 로직 (`/api/recommend`)

설문 결과를 받아: **군 필터**(DB 컬럼 기반) → **성향 점수**(axis_ap/axis_ts + 공간 + 선호도, SQL에서 계산) → **지역 매칭**(sido/sigungu) → **time OR-매칭** → **카테고리 노출 캡**(공원 도배 방지) → **폴백 래더**(희소 지역 자동 확장) → Top N.
응답에 운영시간 경고(`is_time_fixed=0`)·태그칩·코멘트·홈페이지·좌표 포함. API 실패 시 프론트는 내장 폴백 추천으로 동작.

## 로컬 개발

```bash
python3 scripts/csv_to_sql.py                                   # db/data.sql 생성
npx wrangler d1 execute uri-forest-db --local --file=./db/schema.sql
npx wrangler d1 execute uri-forest-db --local --file=./db/data.sql
npx wrangler dev          # http://localhost:8787  ("/" + POST /api/recommend)
```

배포는 [DEPLOY.md](DEPLOY.md) 참고. (원격 적재는 무료 쓰기 한도 주의 — 인덱스 포함 ~33만 writes/적재.)

## 데이터 주의사항

- **`content_id`는 고유하지 않음** (58,906행 / 고유 42,079) → 대리키 `row_id` 사용, content_id는 일반 컬럼.
- **선호도 브릿지는 행 위치(positional)로 조인** (content_id 조회는 중복 때문에 모호). 두 CSV는 행 순서가 1:1 정렬됨.
- `comment_type_A/B`(군별 코멘트)·선호도 가중치는 현재 대부분 비어 있음 → 향후 데이터 보강 대상.

## 상태

Phase 0(구조화)·1(데이터·D1)·2(추천 API)·3(프론트 연결)·4(배포) 완료. 전체 추천 루프가 라이브.
향후: 군별 맞춤 코멘트 생성, 위치 기반 반경 추천, E/F 축 반영.
