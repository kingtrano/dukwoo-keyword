# dukwoo-keyword

네이버 스마트스토어 상품명 SEO 키워드 자동 생성 — **엑셀 일괄 처리 SaaS**.

위탁대행사·도매상·무역회사·중대형 셀러 전용 벌크 키워드 도구.

## 구조

```
dukwoo-keyword/
└── supabase/
    └── functions/
        ├── keyword-tool/         # 메인 백엔드 (Deno)
        │   ├── index.ts          # AI 키워드 + 네이버 검색량 + KQS
        │   ├── keyword-tool.html # 프론트 (베타 단계는 로컬 파일)
        │   └── banned_filters.json
        └── keyword-tool-ui/      # Storage HTML 서빙 프록시
            └── index.ts
```

## 자동 배포

`main` 브랜치에 push 하면 GitHub Actions가 자동으로 Supabase Edge Function 배포.

```
git push origin main
   ↓
GitHub Actions
   ↓
supabase functions deploy (자동)
   ↓
약 1분 후 라이브 반영
```

수동 배포 (긴급 시):
```bash
cd supabase
supabase functions deploy keyword-tool --no-verify-jwt
supabase functions deploy keyword-tool-ui --no-verify-jwt
```

## 환경 변수

Supabase Dashboard → Project Settings → Edge Functions → Secrets에 등록:

| Key | 용도 |
|-----|------|
| `GEMINI_KEY` | Google Gemini API 키 (덕우무역 명의) |
| `NAVER_CUSTOMER_ID` | 네이버 검색광고 Customer ID |
| `NAVER_API_KEY` | 네이버 API 키 |
| `NAVER_SECRET_KEY` | 네이버 시크릿 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Key |

## GitHub Secrets (자동 배포용)

GitHub repo Settings → Secrets and variables → Actions에 등록:

| Key | 값 |
|-----|-----|
| `SUPABASE_ACCESS_TOKEN` | Supabase 대시보드에서 발급 |
| `SUPABASE_PROJECT_REF` | `uifjabklkmvfbsplvxsu` |

## 버전 히스토리

- **v54.1** (2026-05-25) — 카테고리 필터 안전장치 2 추가 (1~4개 키워드일 때 100% 제거 시 BYPASS). 안 이사 50건 회복용.
- **v54** (2026-05-25) — 안전장치 1 완화 (`>= 10` → `>= 5`), HTML 5단계 로그, `seed-expand` action 신규 (시드 확장), `refresh-stale` action 신규 (월간 갱신)
- v53 (5/18) — generate-title 하이브리드 (코드 원자분해 + LLM 자연배열)
- v52 (5/18) — 카테고리 관련성 필터 신규
- v50 (5월 초) — A1/A2 프롬프트 공구 편향 → 범용 예시 교체
- v49 — 캐시 경로 검색량 0→10 치환 버그 수정
- v42 — `--no-verify-jwt` 옵션 도입
- v41 — 카테고리 fire-and-forget → await 전환

## 주요 자산

- `keyword_cache` — 검색량·KQS·카테고리 캐시 (약 13만 건, 자체 시드 확장으로 매일 증가)
- `jj2_category` — JJ2 마이카테코드 → 네이버 카테고리명 매핑 (10,743건)

## 작업 흐름

1. 코드 수정 (로컬 또는 코워크)
2. `git add . && git commit -m "..." && git push`
3. GitHub Actions 자동 배포 (약 1분)
4. 라이브 호출로 검증
