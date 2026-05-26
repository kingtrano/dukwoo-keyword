# web — dukwoo-keyword 프론트엔드

이 폴더 안의 `index.html`이 Vercel에서 자동 호스팅됨.

## URL

- **운영**: https://dukwoo-keyword.vercel.app (또는 dukwoo.ai 도메인 연결 후)
- **수정 후 반영**: `git push` → 약 1분 → 자동 라이브

## 정책 — 단일 소스

이 `index.html`이 유일한 프론트엔드 소스. 다른 곳에 복사본 만들지 말 것.

수정 시:
1. 이 파일을 수정 (다른 폴더 X)
2. `git add web/index.html && git commit -m "..." && git push`
3. Vercel 자동 배포 (~1분)
4. URL 새로고침으로 확인

## Supabase Edge Function 연결

이 페이지는 `https://uifjabklkmvfbsplvxsu.supabase.co/functions/v1/keyword-tool` 백엔드를 호출.
백엔드는 `../supabase/functions/keyword-tool/` 폴더 (Supabase 자동 배포).
