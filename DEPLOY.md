# 우리숲 — Cloudflare 배포 런북

스택: **Cloudflare Workers (Static Assets) + D1**. (Pages 아님 — Cloudflare가 신규 프로젝트는 Workers 권장.)
한 개의 Worker가 `public/index.html`(정적)을 서빙하고 같은 Worker가 `/api/*`를 처리하며 D1을 조회합니다.

```
public/index.html   기존 UI 그대로 (정적 자산)
src/index.js        Worker: /api/* 처리, 그 외는 정적자산으로 폴백
db/schema.sql       테이블 + 인덱스 (1회)
db/data.sql         58,906행 INSERT (scripts/csv_to_sql.py 로 생성, .gitignore됨)
scripts/csv_to_sql.py  data/*.csv -> db/data.sql (positional join)
wrangler.jsonc      Worker + assets + D1 설정
```

---

## 0. 사전 준비 (사용자만 가능)

1. **Cloudflare 계정** (무료 가입, 신용카드 불필요): https://dash.cloudflare.com/sign-up
2. **`wrangler login`** — 브라우저 OAuth 인증. **이 한 단계만 사용자가 직접** 해야 합니다.
   ```bash
   npx wrangler login
   ```
   > 로그인하면 토큰이 로컬에 캐시되어, 이후 `d1 create` / `execute --remote` / `deploy` 같은
   > 원격 명령은 비대화형으로 실행됩니다 → **로그인 후의 나머지 단계는 Claude가 대신 실행 가능**.

---

## 1. D1 데이터베이스 생성 → database_id 설정

```bash
npx wrangler d1 create uri-forest-db
```
출력에 찍히는 `database_id` 를 [wrangler.jsonc](wrangler.jsonc) 의
`d1_databases[0].database_id` (현재 `REPLACE_WITH_ID_FROM_d1_create`) 에 붙여넣습니다.

> Asia-Pacific 우선 배치(한국 사용자 지연 ↓): `npx wrangler d1 create uri-forest-db --location apac`

---

## 2. 데이터 생성 + 원격 D1 적재

```bash
# (필요 시) CSV -> db/data.sql 재생성
python3 scripts/csv_to_sql.py

# 스키마 -> 데이터 순서로 원격 적재
npx wrangler d1 execute uri-forest-db --remote --file=./db/schema.sql
npx wrangler d1 execute uri-forest-db --remote --file=./db/data.sql

# 검증
npx wrangler d1 execute uri-forest-db --remote \
  --command="SELECT COUNT(*) n, SUM(is_program) prog, SUM(is_active) active FROM solutions;"
# 기대값: n=58906, prog=5002, active=55203
```

> ⚠️ **원격 적재는 신중히 1회만.** "rows written"은 **인덱스 쓰기까지 포함**하므로,
> 58,906행 × (테이블+인덱스 5개) ≈ **338,000 writes** 가 실제로 기록됩니다.
> 무료 티어 쓰기 한도(100,000행/일)를 초과하는 양이므로, 같은 날 반복 적재는 피하세요.
> (반복 테스트는 `--local` 로, 무료·무제한.)
>
> 📌 **D1 원격 적재 SQL에는 `BEGIN TRANSACTION`/`COMMIT`/`SAVEPOINT` 금지** — wrangler가
> 자체 트랜잭션을 관리하며 명시적 트랜잭션문을 거부합니다. `scripts/csv_to_sql.py` 는
> 이미 트랜잭션 래퍼 없이 평문 INSERT만 생성합니다(로컬·원격 공통).

---

## 3. 배포

```bash
npx wrangler deploy
# → https://uri-forest.<계정서브도메인>.workers.dev 에 라이브
```

커스텀 도메인 연결(선택): 도메인이 Cloudflare 계정에 있어야 함. 이후 `wrangler.jsonc` 에
```jsonc
"routes": [{ "pattern": "example.kr", "custom_domain": true }]
```

---

## 로컬 개발 (인증 불필요)

```bash
npx wrangler d1 execute uri-forest-db --local --file=./db/schema.sql
npx wrangler d1 execute uri-forest-db --local --file=./db/data.sql
npx wrangler dev          # http://localhost:8787  ("/" + POST /api/recommend, 로컬 D1)
```

---

## 한도 메모 (Workers Free)
- D1: 5GB / 5M reads·day / **100K writes·day** / DB당 500MB (UTC 00:00 리셋)
- Worker 요청: 100K/day. 정적자산(`/`, css, 이미지)은 Worker 호출에 미포함 → `/api/*`만 소모.
- 현재 데이터 ~30MB SQL → 인덱스 포함 수백 MB 이내, 500MB 무료 한도 내.
- `/api/recommend` 는 인덱스(`idx_geo_active` 등) 덕에 요청당 읽는 행이 작음 → reads 한도 여유.
