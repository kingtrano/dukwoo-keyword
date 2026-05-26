// dukwoo-keyword v54.1 — 카테고리 필터 안전장치 2 추가 (1~4개 키워드 BYPASS)
// GitHub Actions 자동 배포 첫 테스트
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// v54.1+ 보안: 모든 secret은 Supabase Edge Function Secrets에만 등록. 코드에 fallback 박지 않음.
const GEMINI_KEY = Deno.env.get("GEMINI_KEY") ?? "";
const NAVER_CUSTOMER_ID = Deno.env.get("NAVER_CUSTOMER_ID") ?? "";
const NAVER_API_KEY = Deno.env.get("NAVER_API_KEY") ?? "";
const NAVER_SECRET_KEY = Deno.env.get("NAVER_SECRET_KEY") ?? "";
if (!GEMINI_KEY || !NAVER_API_KEY) {
  console.error("[FATAL] Required env vars missing: GEMINI_KEY or NAVER_API_KEY");
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://uifjabklkmvfbsplvxsu.supabase.co";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

function getCorsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(key: string, maxPerMin = 30): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) { rateLimitMap.set(key, { count: 1, resetAt: now + 60000 }); return true; }
  if (entry.count >= maxPerMin) return false;
  entry.count++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rateLimitMap) { if (now > v.resetAt) rateLimitMap.delete(k); } }, 300000);

// ── v52: 금칙어/브랜드 필터 삭제 — KIPRIS API(배치 워커 4단계)에서 처리 ──

function validateProductName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== "string") return { valid: false, error: "상품명을 입력해주세요." };
  const t = name.trim();
  if (t.length < 2) return { valid: false, error: "상품명은 2자 이상 입력해주세요." };
  if (t.length > 200) return { valid: false, error: "상품명은 200자 이내로 입력해주세요." };
  if (!/[\uac00-\ud7a3a-zA-Z]/.test(t)) return { valid: false, error: "한글 또는 영문이 포함된 상품명을 입력해주세요." };
  return { valid: true };
}

// ── 상품명 → 핵심 키워드 추출 (브랜드·모델번호·용량 제거) ──
function extractCoreKeywords(productName: string): { core: string; tokens: string[] } {
  let cleaned = productName;
  // 대괄호 내용 제거 [브랜드] [판매자]
  cleaned = cleaned.replace(/\[([^\]]*)\]/g, " ");
  // 모델번호 제거 (알파벳+숫자 조합: KSG-77D, AB-1234, X100T 등)
  cleaned = cleaned.replace(/[A-Za-z]{1,5}[-]?\d{2,}[A-Za-z]*/g, " ");
  cleaned = cleaned.replace(/\d{2,}[-]?[A-Za-z]{1,5}/g, " ");
  // 순수 영문 브랜드명 제거 (대문자로 시작하는 단독 영단어)
  // 단, 범용 영어 단어(pro, max, mini 등)는 유지
  const keepEnglish = new Set(["pro","max","mini","plus","lite","ultra","set","kit","led","usb","dc","ac"]);
  cleaned = cleaned.replace(/\b[A-Za-z]+\b/g, (m) => keepEnglish.has(m.toLowerCase()) ? m : " ");
  // 용량/수량 제거 (800ml, 500g, 1.5L, 100매, 10개, 3P 등)
  cleaned = cleaned.replace(/\d+(\.\d+)?\s*(ml|l|g|kg|oz|매|개|장|p|ea|cc|mm|cm|m|입|박스|세트|팩)\b/gi, " ");
  // 특수문자 정리
  cleaned = cleaned.replace(/[^\uac00-\ud7a3a-zA-Z0-9\s]/g, " ");
  // 토큰화 — 2자 이상 한글 단어만 추출
  const tokens = cleaned.split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && /[\uac00-\ud7a3]/.test(t));
  // 중복 제거
  const unique = [...new Set(tokens)];
  return { core: unique.join(" "), tokens: unique };
}

// ── Gemini 2.5 thinking 모드 응답에서 실제 텍스트만 추출 ──
function extractGeminiText(data: any): string {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts || !Array.isArray(parts)) return "";
  // thinking 파트가 아닌 마지막 텍스트 파트를 찾음
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && !parts[i].thought) return parts[i].text;
  }
  // 모두 thought면 마지막 text라도 반환
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text) return parts[i].text;
  }
  return "";
}

function parseJsonArray(text: string): string[] {
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const match = cleaned.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch { return []; }
}

function parseCount(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "< 10" || s.startsWith("<")) return 0;
    const n = parseInt(s.replace(/,/g, ""), 10);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192; const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
  return btoa(parts.join(""));
}

async function naverSignature(timestamp: string, method: string, uri: string): Promise<string> {
  const message = `${timestamp}.${method}.${uri}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(NAVER_SECRET_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function callGemini(body: object): Promise<any> {
  const errors: string[] = [];
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        if (res.status === 429) {
          const wait = 3000 * (attempt + 1);
          console.warn(`Gemini ${model} 429, wait ${wait}ms (attempt ${attempt})`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (res.status >= 500) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        if (res.status === 404) { errors.push(`${model}:404`); break; }
        if (!res.ok) {
          errors.push(`${model}:${res.status}`);
          break;
        }
        return await res.json();
      } catch (e) {
        if (attempt === 2) { errors.push(`${model}:NET`); break; }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  throw new Error(`Gemini failed: ${errors.join(",")}`);
}

function calcKQS(volume: number, ctr: number, compIdx: string, adDepth: number): { score: number; grade: string } {
  const compMap: Record<string, number> = { "높음": 3, "중간": 2, "낮음": 1 };
  const comp = compMap[compIdx] || 2;
  const adD = Math.max(adDepth, 0.5);
  const effectiveCtr = ctr > 0 ? ctr : (comp === 1 ? 0.05 : comp === 2 ? 0.03 : 0.015);
  const score = Math.round(((volume * effectiveCtr * 2) / (comp * adD)) * 100) / 100;
  let grade = "D";
  if (score >= 15) grade = "S"; else if (score >= 6) grade = "A"; else if (score >= 2) grade = "B"; else if (score >= 0.5) grade = "C";
  return { score, grade };
}

async function getCachedKeywords(keywords: string[]): Promise<Map<string, any>> {
  const cached = new Map();
  if (keywords.length === 0) return cached;
  for (let i = 0; i < keywords.length; i += 100) {
    const batch = keywords.slice(i, i + 100);
    const { data } = await db.from("keyword_cache").select("*").in("keyword", batch);
    if (data) for (const row of data) cached.set(row.keyword, row);
  }
  return cached;
}

async function upsertKeywordCache(items: any[]): Promise<void> {
  if (items.length === 0) return;
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const { error } = await db.from("keyword_cache").upsert(batch, { onConflict: "keyword" });
    if (error) console.error("Cache upsert error:", error.message, error.code);
  }
}

async function logSearch(keywords: string[], source: string, productName: string): Promise<void> {
  const rows = keywords.map(k => ({ keyword: k, source, product_name: productName || null, user_id: null }));
  if (rows.length > 0) { await db.from("keyword_search_log").insert(rows).catch(e => console.error("Log error:", e)); }
}

async function incrementSearchCounts(keywords: string[]): Promise<void> {
  for (const kw of keywords) { await db.rpc("increment_search_count", { kw_text: kw }).catch(() => {}); }
}

async function step1_expandKeywords(productName: string, coreTokens?: string[], categoryName?: string): Promise<string[]> {
  // coreTokens가 외부에서 전달되면 재사용, 아니면 직접 추출
  const tokens = coreTokens || extractCoreKeywords(productName).tokens;
  const coreHint = tokens.length > 0
    ? `\n\n핵심 키워드 힌트: [${tokens.join(", ")}]\n위 핵심 키워드를 기반으로 관련 검색어를 생성하세요. 상품명이 길거나 모델번호가 포함되어 있어도, 소비자가 실제 검색할 일반 키워드를 만들어야 합니다.`
    : "";
  const catHint = categoryName
    ? `\n\n상품 카테고리: ${categoryName}\n반드시 이 카테고리와 직접 관련된 키워드만 생성하세요. 다른 카테고리 상품의 키워드는 절대 포함하지 마세요.`
    : "";
  const prompt = `당신은 네이버 스마트스토어 SEO 전문가입니다.

상품명: "${productName}"${coreHint}${catHint}

이 상품을 네이버에서 검색할 때 소비자가 실제로 입력하는 키워드를 생성하세요.

반드시 포함할 패턴:
1. [용도/상황]+[상품명]: 이 상품을 쓰는 상황 + 상품명 (예: 캠핑라면, 목공타카, 사무실의자)
2. [재료/맛/특성]+[상품명]: 감각적 특성 + 상품명 (예: 매운라면, 나무선반, 스테인리스냄비)
3. [방식/타입]+[상품명]: 방식이나 분류 + 상품명 (예: 즉석라면, 충전드릴, 접이식테이블)
4. [상품명]+[형태/단위]: 상품명 + 형태 (예: 라면세트, 라면박스, 타카건, 의자세트)
5. [대상]+[상품명]: 사용자나 타겟 + 상품명 (예: 자취생라면, 목수타카, 아기의자)
6. 동의어/유사어: 같은 상품의 다른 이름 전부 (예: 인스턴트면, 컵누들, 핀네일러)

규칙:
1. 패턴당 5~10개씩, 총 30~50개
2. 띄어쓰기 없이 붙여쓰기
3. 브랜드명/모델번호는 제외
4. 단독 수식어 금지 (예: "충전", "매운" 단독은 안됨, 반드시 상품명과 결합)
5. 실제 네이버에서 검색될 자연스러운 조합만 생성
6. 원본 상품과 동일한 카테고리의 키워드만 생성
7. 3글자 이상의 조합 키워드만 생성 (2글자 이하 단일 단어 금지)

JSON 배열로만 반환. 예: ["캠핑라면", "매운라면", "라면세트"]`;
  try {
    const data = await callGemini({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } } });
    const text = extractGeminiText(data) || "[]";
    const raw = parseJsonArray(text);
    const combined = [...new Set([...raw.filter((k: any) => typeof k === "string" && k.length >= 2), ...tokens])];
    return combined.slice(0, 100);
  } catch (e) { console.error("Step1 error:", e); return []; }
}

// ── Step A2: 수식어 추출 + 기계적 조합 ──

async function step1b_extractModifiers(productName: string, tokens: string[], categoryName?: string): Promise<{ coreWords: string[]; synonyms: string[]; modifiers: string[]; compounds: string[]; category: string }> {
  // A2-1: 핵심 상품어 + 동의어 + 카테고리 결정
  // categoryName이 제공되면 Gemini의 카테고리 추측을 건너뛰고 확정값 사용
  const catInstruction = categoryName
    ? `\n- category: "${categoryName}" (확정, 변경하지 마세요)`
    : `\n- category: 네이버 쇼핑 대분류 카테고리 1개 (예: 공구, 가전, 가구/인테리어, 생활용품, 주방용품, 스포츠/레저, 식품, 패션의류, 패션잡화, 화장품/미용, 디지털/컴퓨터, 출산/유아동, 반려동물, 자동차용품, 문구/오피스, 건강/의료, 악기, 완구/취미)`;
  const corePrompt = `상품명: "${productName}"\n\n이 상품의 핵심 카테고리 명사와, 같은 상품을 부르는 다른 이름(동의어), 그리고 상품 카테고리를 뽑아주세요.\n\n반환 형식 (JSON):\n{"coreWords": ["실타카"], "synonyms": ["타카", "타카건", "네일건", "핀네일러", "스테이플건"], "category": "공구"}\n\n- coreWords: 이 상품의 대표 명사 1~2개 (소비자가 가장 많이 검색하는 이름)\n- synonyms: 같은 상품을 부르는 다른 이름들 3~8개 (줄임말, 영어표현, 전문용어, 구어체 포함)${catInstruction}\n- 브랜드명/모델번호 제외\n- JSON만 반환`;

  let coreWords: string[] = [];
  let synonyms: string[] = [];
  let category: string = categoryName || "";
  try {
    const coreData = await callGemini({ contents: [{ parts: [{ text: corePrompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } } });
    const coreText = extractGeminiText(coreData) || "{}";
    const cleaned = coreText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        coreWords = (parsed.coreWords || []).filter((k: any) => typeof k === "string" && k.length >= 2);
        synonyms = (parsed.synonyms || []).filter((k: any) => typeof k === "string" && k.length >= 1);
        // categoryName이 제공되지 않았을 때만 Gemini 추측값 사용
        if (!categoryName) {
          category = (typeof parsed.category === "string") ? parsed.category.trim() : "";
        }
      } catch { coreWords = []; synonyms = []; }
    }
    // fallback: JSON 파싱 실패 시 배열로 시도
    if (coreWords.length === 0) {
      coreWords = parseJsonArray(coreText).filter((k: any) => typeof k === "string" && k.length >= 2);
    }
  } catch (e) { console.error("A2 core error:", e); }

  // fallback: tokens에서 가장 긴 단어를 핵심어로
  if (coreWords.length === 0 && tokens.length > 0) {
    coreWords = [tokens.reduce((a, b) => a.length >= b.length ? a : b)];
  }
  if (coreWords.length === 0) return { coreWords: [], synonyms: [], modifiers: [], compounds: [], category: "" };

  console.log(`[step-A2] coreWords: ${coreWords.join(", ")}, synonyms: ${synonyms.join(", ")}, category: ${category}`);

  // A2-2: 수식어 추출 (카테고리 범용)
  const modPrompt = `당신은 네이버 쇼핑 키워드 전문가입니다.

상품명: "${productName}"
핵심 상품어: [${coreWords.join(", ")}]
동의어: [${synonyms.join(", ")}]
카테고리: ${category || "미분류"}

이 상품의 핵심 상품어/동의어 앞뒤에 붙여서 네이버 검색 키워드를 만들 수 있는 수식어를 모두 뽑으세요.

반드시 포함할 유형:
1. 맛/향/색상/재질: 이 상품을 구분하는 감각적 특성 (예: 매운, 순한, 빨간, 검정, 하얀, 스테인리스, 실리콘, 면, 가죽)
2. 용도/장소/상황: 이 상품을 쓰는 맥락 (예: 캠핑, 사무실, 가정용, 업소용, 선물용, 혼밥, 야외, 목공, 인테리어)
3. 대상/타겟: 이 상품을 쓰는 사람 (예: 자취생, 아이, 초보, 전문가, 1인가구, 학생, 직장인)
4. 크기/수량/규격: 물리적 특성 (예: 대용량, 소형, 미니, 멀티팩, 세트, 벌크, 1인분, 가족용)
5. 방식/기능/타입: 작동 방식이나 분류 (예: 즉석, 건면, 전자레인지, 충전식, 무선, 접이식, 자동)
6. 형태접미어: 상품명 뒤에 붙는 형태 (예: 세트, 팩, 박스, 건, 기, 총, 묶음)
7. 수식형용사: 검색에 자주 쓰이는 형용사 (예: 맛있는, 저칼로리, 간편, 초간단, 가성비)

규칙:
- 반드시 한 단어씩 (띄어쓰기 없이)
- 1글자("건","총","맛")도 포함
- 브랜드명/모델번호 제외
- 총 40~60개
- JSON 배열로만 반환

예시(식품): ["매운","순한","국물","건면","즉석","전자레인지","캠핑","자취생","혼밥","1인분","대용량","멀티팩","박스","세트","묶음","선물용","간편","맛있는"]
예시(공구): ["충전","무선","목공","나무","목재","목수","건","총","기","소형","경량"]`;

  let modifiers: string[] = [];
  try {
    const modData = await callGemini({ contents: [{ parts: [{ text: modPrompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } } });
    const modText = extractGeminiText(modData) || "[]";
    modifiers = parseJsonArray(modText).filter((k: any) => typeof k === "string" && k.length >= 1);
    modifiers = [...new Set(modifiers)].slice(0, 60);
  } catch (e) { console.error("A2 modifier error:", e); }

  console.log(`[step-A2] modifiers: ${modifiers.length}개 — ${modifiers.slice(0, 10).join(", ")}...`);

  // A2-3: 기계적 조합 (핵심어 + 동의어 모두 사용)
  const compounds = generateCompounds(coreWords, synonyms, modifiers);
  console.log(`[step-A2] compounds: ${compounds.length}개`);

  return { coreWords, synonyms, modifiers, compounds, category };
}

function generateCompounds(coreWords: string[], synonyms: string[], modifiers: string[]): string[] {
  const result = new Set<string>();
  const allCores = [...new Set([...coreWords, ...synonyms])];

  for (const core of allCores) {
    // 2단어: 수식어 + 핵심어 (양방향)
    for (const mod of modifiers) {
      result.add(mod + core);        // 충전실타카, 충전타카, 충전네일건
      result.add(core + mod);        // 실타카충전, 타카건충전
    }

    // 3단어: 상위 10개 수식어 간 조합
    const top = modifiers.slice(0, 10);
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        result.add(top[i] + top[j] + core);   // 충전무선실타카
        result.add(top[j] + top[i] + core);   // 무선충전실타카
        result.add(top[i] + core + top[j]);   // 충전실타카무선
      }
    }
  }

  // 500개 cap (네이버 확장 없으므로 여유 있음)
  return [...result].slice(0, 500);
}

// ── 이미지 필터 v2: 2단계 (이미지 설명 추출 → 관련성 점수 매칭) ──
const IMAGE_RELEVANCE_CUTOFF = 85;

async function fetchImageBase64(imageUrl: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const imgRes = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!imgRes.ok) return null;
    const imgBuf = await imgRes.arrayBuffer();
    if (imgBuf.byteLength > 4 * 1024 * 1024) return null;
    return {
      base64: uint8ToBase64(new Uint8Array(imgBuf)),
      mimeType: imgRes.headers.get("content-type") || "image/jpeg",
    };
  } catch { return null; }
}

async function step2a_describeImage(imageUrl: string): Promise<string | null> {
  const img = await fetchImageBase64(imageUrl);
  if (!img) return null;
  const prompt = `이 이미지에 보이는 상품을 한 줄로 설명하세요.\n형식: "카테고리 + 핵심 특징 + 소재/색상"\n예: "빨간색 충전식 전동 타카 공구"\n예: "흰색 EVA 재질 논슬립 선반 매트"\n\n한 줄 텍스트만 반환. 따옴표, 설명, 부연 없이.`;
  try {
    const data = await callGemini({
      contents: [{ parts: [{ inlineData: { mimeType: img.mimeType, data: img.base64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } },
    });
    const text = extractGeminiText(data)?.trim();
    if (!text || text.length < 3) { console.error("[step2a] empty text from Gemini"); return null; }
    console.log(`[image-desc] "${text}"`);
    return text;
  } catch (e) { console.error("step2a error:", e); return null; }
}

function parseJsonObject(text: string): Record<string, number> {
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  // greedy match — 첫 { 에서 마지막 } 까지
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try { return JSON.parse(match[0]); } catch { return {}; }
}

// step2b_scoreKeywords는 step2b_scoreKeywordsDetailed로 교체됨

interface ImageFilterResult {
  keywords: string[];
  imageDesc: string | null;
  scores: Record<string, number>;
  skipped: string | null;  // null이면 정상 실행, 아니면 스킵 사유
}

async function step2_filterByImage(keywords: string[], imageUrl: string, productName: string, prefetchedDesc?: string | null): Promise<ImageFilterResult> {
  if (!imageUrl || keywords.length === 0) return { keywords, imageDesc: null, scores: {}, skipped: !imageUrl ? "no_imageUrl" : "no_keywords" };
  // Step 2a: 이미지 → 한 줄 설명 (선행 fetch 결과가 있으면 재사용)
  const imageDesc = prefetchedDesc || await step2a_describeImage(imageUrl);
  if (!imageDesc) return { keywords, imageDesc: null, scores: {}, skipped: "step2a_failed" };
  // Step 2b: 키워드 vs 이미지 설명 → 관련성 점수 → 85점 이상만 통과
  const result = await step2b_scoreKeywordsDetailed(keywords, imageDesc);
  // 안전장치: 이미지 필터가 80% 이상 탈락시키면 필터 무시 (이미지 인식 실패로 판단)
  if (result.passed.length < keywords.length * 0.2 && keywords.length >= 5) {
    console.log(`[image-filter] BYPASS — ${result.passed.length}/${keywords.length} 통과 (80%+ 탈락, 이미지 필터 무시)`);
    return { keywords, imageDesc, scores: result.scores, skipped: "bypass_too_aggressive" };
  }
  return { keywords: result.passed, imageDesc, scores: result.scores, skipped: null };
}

async function step2b_scoreKeywordsDetailed(keywords: string[], imageDesc: string): Promise<{ passed: string[]; scores: Record<string, number> }> {
  if (keywords.length === 0) return { passed: [], scores: {} };
  const prompt = `상품 이미지 설명: "${imageDesc}"\n\n아래 키워드 각각이 위 상품과 얼마나 관련 있는지 0~100 점수를 매기세요.\n- 100: 상품 그 자체를 설명하는 키워드\n- 85+: 상품의 용도, 기능, 소재, 설치 장소 등 직접 관련\n- 50~84: 간접적 연관 (같은 카테고리이나 다른 제품)\n- 0~49: 전혀 무관한 키워드\n\nJSON 객체로만 반환. 예: {"키워드1": 95, "키워드2": 30}\n\n키워드: ${JSON.stringify(keywords)}`;
  try {
    const data = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    });
    const text = extractGeminiText(data) || "{}";
    const scores = parseJsonObject(text);
    const passed: string[] = [];
    const dropped: string[] = [];
    for (const kw of keywords) {
      const score = scores[kw];
      if (score !== undefined && score >= IMAGE_RELEVANCE_CUTOFF) {
        passed.push(kw);
      } else if (score === undefined) {
        // Gemini가 빠뜨린 키워드는 보수적으로 통과
        passed.push(kw);
      } else {
        dropped.push(`${kw}(${score})`);
      }
    }
    console.log(`[image-filter] cutoff=${IMAGE_RELEVANCE_CUTOFF} passed=${passed.length} dropped=${dropped.length}: ${dropped.slice(0, 10).join(", ")}`);
    // scores가 비어있으면(파싱 실패) 보수적으로 전체 통과, 아니면 필터 결과 존중
    if (Object.keys(scores).length === 0) {
      return { passed: keywords, scores };
    }
    return { passed, scores };
  } catch (e) { console.error("step2b error:", e); return { passed: keywords, scores: {} }; }
}

// ── v52: 카테고리 관련성 필터 — 마이카테 기반으로 무관 키워드 제거 ──
async function stepCategoryFilter(keywords: string[], categoryName: string): Promise<{ passed: string[]; removed: string[] }> {
  if (!categoryName || keywords.length === 0) return { passed: keywords, removed: [] };
  // 카테고리명에서 대분류 추출 (예: "자동차용품 > 실외용품 > 차량용 바디커버" → "자동차용품")
  const catParts = categoryName.split(">").map(s => s.trim());
  const prompt = `상품 카테고리: "${categoryName}"

아래 키워드 목록에서 위 카테고리와 전혀 관련이 없는 키워드만 골라내세요.

판단 기준:
- 이 카테고리 상품을 검색할 때 절대 사용하지 않을 키워드 = 제거
- 이 카테고리 상품의 용도, 재료, 특성, 설치 장소와 관련된 키워드 = 유지
- 애매하면 유지 (보수적으로 판단)

제거할 키워드만 JSON 배열로 반환. 관련 없는 것이 없으면 빈 배열 [].
예: ["무관키워드1", "무관키워드2"]

키워드 목록: ${JSON.stringify(keywords)}`;
  try {
    const data = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
    });
    const text = extractGeminiText(data) || "[]";
    const removeList = parseJsonArray(text).filter((k: any) => typeof k === "string");
    const removeSet = new Set(removeList.map((k: string) => k.toLowerCase().replace(/\s/g, "")));
    const passed: string[] = [];
    const removed: string[] = [];
    for (const kw of keywords) {
      if (removeSet.has(kw.toLowerCase().replace(/\s/g, ""))) {
        removed.push(kw);
      } else {
        passed.push(kw);
      }
    }
    // 안전장치 1: 70% 이상 제거되면 필터 실패로 판단 → 전체 통과 (v54: 10→5로 완화)
    if (passed.length < keywords.length * 0.3 && keywords.length >= 5) {
      console.log(`[cat-filter] BYPASS-large — ${removed.length}/${keywords.length} 제거 (70%+ 제거, 필터 무시)`);
      return { passed: keywords, removed: [] };
    }
    // 안전장치 2 (v54.1): 키워드 1~4개일 때 100% 제거 시 → 전체 통과 (안 이사 50건 회복용)
    if (passed.length === 0 && keywords.length >= 1) {
      console.log(`[cat-filter] BYPASS-small — all ${keywords.length} removed in small set, falling back to original`);
      return { passed: keywords, removed: [] };
    }
    console.log(`[cat-filter] cat="${catParts[0]}" passed=${passed.length} removed=${removed.length}: ${removed.slice(0, 10).join(", ")}`);
    return { passed, removed };
  } catch (e) {
    console.error("Category filter error:", e);
    return { passed: keywords, removed: [] };
  }
}

interface KeywordResult {
  keyword: string; volume: number; pc_volume: number; mobile_volume: number;
  comp_idx: string; avg_clk: number; avg_ctr: number; ad_depth: number;
  kqs_score: number; kqs_grade: string;
}

async function step3_checkVolume(keywords: string[], category?: string): Promise<KeywordResult[]> {
  if (keywords.length === 0) return [];
  const results = new Map<string, KeywordResult>();
  const kwLookup = new Set(keywords.map(k => k.toLowerCase().replace(/\s/g, "")));
  const cacheItems: any[] = [];
  const cached = await getCachedKeywords(keywords);
  const cachedHits: string[] = [];
  for (const [kw, row] of cached) {
    // 필터: PC >= 10 OR 모바일 >= 10 (하나만 충족) AND 총합 <= 50000
    const pcVol = Number(row.monthly_pc_qc_cnt) || 0;
    const moVol = Number(row.monthly_mobile_qc_cnt) || 0;
    const total = pcVol + moVol;
    if ((pcVol >= 10 || moVol >= 10) && total <= 50000) {
      const { score, grade } = calcKQS(row.monthly_qc_cnt, Number(row.monthly_avg_ctr) || 0, row.comp_idx || "", Number(row.pl_avg_depth) || 0);
      results.set(kw, { keyword: kw, volume: row.monthly_qc_cnt, pc_volume: row.monthly_pc_qc_cnt, mobile_volume: row.monthly_mobile_qc_cnt, comp_idx: row.comp_idx || "", avg_clk: Number(row.monthly_avg_clk_cnt) || 0, avg_ctr: Number(row.monthly_avg_ctr) || 0, ad_depth: Number(row.pl_avg_depth) || 0, kqs_score: score, kqs_grade: grade });
      cachedHits.push(kw);
    }
  }
  if (cachedHits.length > 0) incrementSearchCounts(cachedHits).catch(() => {});
  // 캐시된 키워드 중 category가 없는 것들 업데이트
  if (category && cachedHits.length > 0) {
    const needCategoryUpdate = cachedHits.filter(kw => !cached.get(kw)?.category);
    if (needCategoryUpdate.length > 0) {
      for (let i = 0; i < needCategoryUpdate.length; i += 100) {
        const batch = needCategoryUpdate.slice(i, i + 100);
        const { error: catErr } = await db.from("keyword_cache").update({ category }).in("keyword", batch);
        if (catErr) console.error("Category update error:", catErr.message);
      }
      console.log(`[cache] category="${category}" updated for ${needCategoryUpdate.length} cached keywords`);
    }
  }
  const uncached = keywords.filter(k => !cached.has(k));
  // ── 네이버 API 3배속 병렬 호출 (5개씩 3묶음 = 15개 동시) ──
  const PARALLEL = 3;
  const processNaverBatch = async (batchKeywords: string[], batchIdx: number) => {
    const hint = batchKeywords.join(",");
    const uri = "/keywordstool";
    // 병렬 호출 시 각각 고유한 timestamp 사용 (충돌 방지)
    const timestamp = String(Date.now() + batchIdx);
    const sig = await naverSignature(timestamp, "GET", uri);
    const params = new URLSearchParams({ hintKeywords: hint, showDetail: "1" });
    try {
      const res = await fetch(`https://api.searchad.naver.com${uri}?${params}`, {
        headers: { "Content-Type": "application/json", "X-Timestamp": timestamp, "X-API-KEY": NAVER_API_KEY, "X-Customer": NAVER_CUSTOMER_ID, "X-Signature": sig },
      });
      if (!res.ok) { console.warn(`Naver API ${res.status} batch ${batchIdx}`); return; }
      const data = await res.json();
      for (const kw of data?.keywordList || []) {
        const kwNorm = kw.relKeyword.toLowerCase().replace(/\s/g, "");
        if (!kwLookup.has(kwNorm) || results.has(kw.relKeyword)) continue;
        const pcNum = parseCount(kw.monthlyPcQcCnt);
        const moNum = parseCount(kw.monthlyMobileQcCnt);
        const total = pcNum + moNum;
        const compIdx = kw.compIdx || "";
        const pcClk = Number(kw.monthlyAvPcClkCnt) || 0; const moClk = Number(kw.monthlyAvMobileClkCnt) || 0;
        const avgClk = pcClk + moClk || Number(kw.monthlyAvClkCnt) || 0;
        const pcCtr = Number(kw.monthlyAvPcCtr) || 0; const moCtr = Number(kw.monthlyAvMobileCtr) || 0;
        const avgCtr = moCtr > 0 ? moCtr : (pcCtr > 0 ? pcCtr : Number(kw.monthlyAvCtr) || 0);
        const adDepth = Number(kw.plAvgDepth) || 0;
        const { score, grade } = calcKQS(total, avgCtr, compIdx, adDepth);
        if (pcNum > 0 || moNum > 0) {
          cacheItems.push({ keyword: kw.relKeyword, monthly_pc_qc_cnt: pcNum, monthly_mobile_qc_cnt: moNum, monthly_qc_cnt: total, comp_idx: compIdx, monthly_avg_clk_cnt: avgClk, monthly_avg_ctr: avgCtr, pl_avg_depth: adDepth, kqs_score: score, kqs_grade: grade, ...(category ? { category } : {}), last_refreshed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        }
        if ((pcNum >= 10 || moNum >= 10) && total <= 50000) {
          results.set(kw.relKeyword, { keyword: kw.relKeyword, volume: total, pc_volume: pcNum, mobile_volume: moNum, comp_idx: compIdx, avg_clk: avgClk, avg_ctr: avgCtr, ad_depth: adDepth, kqs_score: score, kqs_grade: grade });
        }
      }
    } catch (e) { console.error(`Naver API error batch ${batchIdx}:`, e); }
  };
  let batchCounter = 0;
  for (let i = 0; i < uncached.length; i += 5 * PARALLEL) {
    const promises: Promise<void>[] = [];
    for (let p = 0; p < PARALLEL; p++) {
      const start = i + p * 5;
      if (start >= uncached.length) break;
      promises.push(processNaverBatch(uncached.slice(start, start + 5), batchCounter++));
    }
    await Promise.all(promises);
    if (i + 5 * PARALLEL < uncached.length) await new Promise(r => setTimeout(r, 300));
  }
  await upsertKeywordCache(cacheItems);
  return [...results.values()].sort((a, b) => b.volume - a.volume);
}

// ── 네이버 연관 키워드 전체 수집 (확장용) ──
interface NaverKeywordInfo {
  keyword: string; pcVolume: number; mobileVolume: number; totalVolume: number;
  compIdx: string; avgClk: number; avgCtr: number; adDepth: number;
}

async function naverFetchAllRelated(inputKeywords: string[]): Promise<Map<string, NaverKeywordInfo>> {
  const result = new Map<string, NaverKeywordInfo>();
  const cacheItems: any[] = [];
  if (inputKeywords.length === 0) return result;

  // 캐시 확인 — 캐시된 키워드는 API 호출 생략
  const cached = await getCachedKeywords(inputKeywords);
  const uncachedKeywords: string[] = [];
  for (const kw of inputKeywords) {
    if (cached.has(kw)) {
      const row = cached.get(kw);
      result.set(kw, {
        keyword: kw,
        pcVolume: Number(row.monthly_pc_qc_cnt) || 0,
        mobileVolume: Number(row.monthly_mobile_qc_cnt) || 0,
        totalVolume: Number(row.monthly_qc_cnt) || 0,
        compIdx: row.comp_idx || "",
        avgClk: Number(row.monthly_avg_clk_cnt) || 0,
        avgCtr: Number(row.monthly_avg_ctr) || 0,
        adDepth: Number(row.pl_avg_depth) || 0,
      });
    } else {
      uncachedKeywords.push(kw);
    }
  }
  console.log(`[naver-expand] input=${inputKeywords.length}, cached=${cached.size}, uncached=${uncachedKeywords.length}`);

  for (let i = 0; i < uncachedKeywords.length; i += 5) {
    const batch = uncachedKeywords.slice(i, i + 5);
    const hint = batch.join(",");
    const uri = "/keywordstool";
    const timestamp = String(Date.now());
    const sig = await naverSignature(timestamp, "GET", uri);
    const params = new URLSearchParams({ hintKeywords: hint, showDetail: "1" });
    try {
      const res = await fetch(`https://api.searchad.naver.com${uri}?${params}`, {
        headers: { "Content-Type": "application/json", "X-Timestamp": timestamp, "X-API-KEY": NAVER_API_KEY, "X-Customer": NAVER_CUSTOMER_ID, "X-Signature": sig },
      });
      if (!res.ok) { console.warn(`Naver API ${res.status} batch ${i}`); continue; }
      const data = await res.json();
      for (const kw of data?.keywordList || []) {
        if (result.has(kw.relKeyword)) continue;
        const pc = parseCount(kw.monthlyPcQcCnt);
        const mo = parseCount(kw.monthlyMobileQcCnt);
        const total = pc + mo;
        const compIdx = kw.compIdx || "";
        const pcClk = Number(kw.monthlyAvPcClkCnt) || 0;
        const moClk = Number(kw.monthlyAvMobileClkCnt) || 0;
        const avgClk = pcClk + moClk || Number(kw.monthlyAvClkCnt) || 0;
        const pcCtr = Number(kw.monthlyAvPcCtr) || 0;
        const moCtr = Number(kw.monthlyAvMobileCtr) || 0;
        const avgCtr = moCtr > 0 ? moCtr : (pcCtr > 0 ? pcCtr : Number(kw.monthlyAvCtr) || 0);
        const adDepth = Number(kw.plAvgDepth) || 0;
        result.set(kw.relKeyword, { keyword: kw.relKeyword, pcVolume: pc, mobileVolume: mo, totalVolume: total, compIdx, avgClk, avgCtr, adDepth });
        // 검색량 있는 키워드만 캐시 저장
        if (pc > 0 || mo > 0) {
          cacheItems.push({ keyword: kw.relKeyword, monthly_pc_qc_cnt: pc, monthly_mobile_qc_cnt: mo, monthly_qc_cnt: total, comp_idx: compIdx, monthly_avg_clk_cnt: avgClk, monthly_avg_ctr: avgCtr, pl_avg_depth: adDepth, kqs_score: 0, kqs_grade: "D", last_refreshed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        }
      }
    } catch (e) { console.error(`Naver expand error batch ${i}:`, e); }
    if (i + 5 < uncachedKeywords.length) await new Promise(r => setTimeout(r, 300));
  }
  await upsertKeywordCache(cacheItems).catch(e => console.error("Cache save error:", e));
  return result;
}

// ── v53: /generate-title — 하이브리드 (코드: 원자분해+커버리지 → LLM: 자연배열) ──

/** 네이버 매칭 시뮬: tokens 집합으로 keyword를 완전 커버하는지 */
function naverMatch(tokens: Set<string>, keyword: string): boolean {
  let remaining = keyword;
  const sorted = [...tokens].sort((a, b) => b.length - a.length);
  for (const t of sorted) {
    remaining = remaining.replace(t, "");
  }
  return !/[가-힣]/.test(remaining);
}

/** 키워드를 알려진 토큰으로 분해, 남은 부분(새 원자) 반환 */
function decomposeKw(kw: string, known: Set<string>): { used: string[]; leftovers: string[] } {
  let remaining = kw;
  const used: string[] = [];
  const sorted = [...known].sort((a, b) => b.length - a.length);
  for (const t of sorted) {
    if (remaining.includes(t)) {
      used.push(t);
      remaining = remaining.replace(t, "\x00");
    }
  }
  const leftovers = remaining.split("\x00").filter(p => p.length >= 2 && /^[가-힣]+$/.test(p));
  return { used, leftovers };
}

async function handleGenerateTitle(body: any, cors: Record<string, string>): Promise<Response> {
  const { productName, keywords, categoryName } = body;
  if (!productName || typeof productName !== "string") {
    return new Response(JSON.stringify({ error: "productName 필수", code: "INVALID_INPUT" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return new Response(JSON.stringify({ error: "keywords 배열 필수", code: "INVALID_INPUT" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const topKeywords = keywords.slice(0, 30);
  const kwList: { keyword: string; volume: number }[] = topKeywords.map(k =>
    typeof k === "string" ? { keyword: k, volume: 0 } : { keyword: k.keyword || "", volume: k.volume || 0 }
  );
  const kwStrings = kwList.map(k => k.keyword.replace(/[^가-힣]/g, "")).filter(k => k.length >= 2);
  const catHint = categoryName ? `\n카테고리: ${categoryName}` : "";

  // === Step 0: 원본 상품명에서 토큰 분류 ===
  const origParts = productName.split(/[\s\[\]]+/).filter(Boolean);
  const origKorean: string[] = [];
  const origModel: string[] = [];   // 모델번호 (FC115, G2172) → 맨 앞
  const origSize: string[] = [];    // 사이즈 (1cm, 8M) → 맨 뒤
  for (const p of origParts) {
    const kr = p.replace(/[^가-힣]/g, "");
    if (kr.length >= 2) { origKorean.push(kr); continue; }
    if (/^\d+colors?$/i.test(p)) continue;  // Ncolors 제거
    if (p.length < 2) continue;  // x 같은 1자 제거
    // 모델번호 = 영문1~4자 + 숫자
    if (/^[A-Za-z]{1,4}\d+/.test(p)) { origModel.push(p); continue; }
    // 사이즈 = 숫자+단위 (1cm, 8M, 600x400 등)
    if (/^\d+(mm|cm|M|ml|L|g|kg)?$/i.test(p) || /^\d+x\d+$/i.test(p)) { origSize.push(p); continue; }
    // PVC 같은 순수 영문 → 제거
  }

  // === Step 1: 원본 복합어 분리 (4자+ & 키워드 빈도 기반, 엄격) ===
  const initTokens: string[] = [];
  for (const tok of origKorean) {
    if (tok.length <= 3) { initTokens.push(tok); continue; }
    let bestSplit: string[] = [tok], bestScore = 0;
    for (let cut = 2; cut <= tok.length - 2; cut++) {
      const left = tok.slice(0, cut), right = tok.slice(cut);
      if (left.length < 2 || right.length < 2) continue;
      const lf = kwStrings.filter(kw => kw.includes(left)).length;
      const rf = kwStrings.filter(kw => kw.includes(right)).length;
      // 양쪽 3회 이상 등장해야 분리
      if (lf >= 3 && rf >= 3 && (lf + rf) > bestScore) {
        bestScore = lf + rf;
        bestSplit = [left, right];
      }
    }
    initTokens.push(...bestSplit);
  }

  // === Step 2: 접미사 감지 (25%+ 키워드가 해당 글자로 끝남) ===
  const suffixes = new Set<string>();
  for (const char of ["장", "대", "기", "함", "통"]) {
    const ratio = kwStrings.filter(kw => kw.endsWith(char)).length / Math.max(kwStrings.length, 1);
    if (ratio >= 0.25) suffixes.add(char);
  }

  // 접미사로 끝나는 토큰 → prefix + suffix 분리 (수납장 → 수납 + 장)
  const expandedTokens: string[] = [];
  for (const tok of initTokens) {
    if (tok.length >= 3 && suffixes.has(tok[tok.length - 1])) {
      const prefix = tok.slice(0, -1);
      if (prefix.length >= 2) expandedTokens.push(prefix);
      else expandedTokens.push(tok);
    } else {
      expandedTokens.push(tok);
    }
  }
  for (const s of suffixes) {
    if (!expandedTokens.includes(s)) expandedTokens.push(s);
  }

  // === Step 3: 키워드 순서대로 분해 → 새 원자단어 수집 ===
  const known = new Set([...expandedTokens, ...suffixes]);
  const newAtoms: string[] = [];
  const newSet = new Set<string>();

  for (const kw of kwStrings) {
    const { leftovers } = decomposeKw(kw, known);
    for (const atom of leftovers) {
      if (!known.has(atom) && !newSet.has(atom)) {
        newAtoms.push(atom);
        newSet.add(atom);
        known.add(atom);
      }
    }
  }

  // === Step 4: Greedy 커버리지 선별 ===
  const current = new Set([...expandedTokens, ...suffixes]);
  const selected: string[] = [];

  // 순서대로 커버리지 기여 확인
  let baseCov = kwStrings.filter(kw => naverMatch(current, kw)).length;
  for (const atom of newAtoms) {
    const testSet = new Set([...current, atom]);
    const testCov = kwStrings.filter(kw => naverMatch(testSet, kw)).length;
    if (testCov > baseCov) {
      selected.push(atom);
      current.add(atom);
      baseCov = testCov;
    }
    if (selected.length >= 6) break;
  }

  // 추가 greedy: prefix/suffix 후보에서 놓친 것 잡기 (노이즈 제거)
  const extraCandidates = new Set<string>();
  for (const kw of kwStrings.slice(0, 20)) {
    for (let ln = 2; ln <= Math.min(kw.length, 4); ln++) {
      const prefix = kw.slice(0, ln);
      const suffix = kw.slice(-ln);
      // 이미 있는 토큰과 결합된 노이즈 제거 (예: "단책장"="단"+"책장")
      if (/^[가-힣]+$/.test(prefix)) extraCandidates.add(prefix);
      if (/^[가-힣]+$/.test(suffix)) extraCandidates.add(suffix);
    }
  }
  for (const t of current) extraCandidates.delete(t);
  // 기존 토큰의 부분 문자열인 후보 제거 (노이즈: "단책장" 안에 "책장" 이미 있음)
  for (const cand of [...extraCandidates]) {
    for (const t of current) {
      if (cand.length > t.length && cand.includes(t)) { extraCandidates.delete(cand); break; }
      if (t.length > cand.length && t.includes(cand)) { extraCandidates.delete(cand); break; }
    }
  }

  for (let i = 0; i < 3; i++) {
    baseCov = kwStrings.filter(kw => naverMatch(current, kw)).length;
    let best = "", bestGain = 0;
    for (const atom of extraCandidates) {
      if (current.has(atom)) continue;
      const testSet = new Set([...current, atom]);
      const gain = kwStrings.filter(kw => naverMatch(testSet, kw)).length - baseCov;
      if (gain > bestGain) { bestGain = gain; best = atom; }
    }
    if (best && bestGain > 0) { selected.push(best); current.add(best); extraCandidates.delete(best); }
    else break;
  }

  // === Step 5: 커버리지 계산 + atom pool 크기 제한 ===
  const finalCoverage = kwStrings.filter(kw => naverMatch(current, kw)).length;
  const coverageRatio = `${finalCoverage}/${kwStrings.length}`;

  // 원자단어 풀 정리 (원본 expanded + 추가 selected, 중복 제거, 최대 12개)
  const atomPool = [...expandedTokens.filter((v, i, a) => a.indexOf(v) === i)];
  for (const s of selected) { if (!atomPool.includes(s) && atomPool.length < 12) atomPool.push(s); }

  console.log(`[generate-title] atoms: [${atomPool.join(",")}] coverage: ${coverageRatio}`);

  // === Step 6: 코드 기반 상품명 조합 (LLM 없음, 네이버 공식 순서) ===
  // 순서: ①모델번호 → ②한글 원자단어 → ③사이즈(뒤)
  const MAX_LEN = 45;
  const parts: string[] = [];
  const seen = new Set<string>();

  // ① 모델번호 (있으면 앞)
  for (const m of origModel) {
    if (!seen.has(m)) { parts.push(m); seen.add(m); }
  }
  // ② 한글 원자단어 (atomPool 순서 = 원본 우선 + 커버리지 기여 순)
  for (const a of atomPool) {
    if (!seen.has(a)) { parts.push(a); seen.add(a); }
  }
  // ③ 사이즈 (맨 뒤)
  for (const s of origSize) {
    if (!seen.has(s)) { parts.push(s); seen.add(s); }
  }

  // 45자 초과 시 뒤에서부터 제거 (모델 + 최소 원자 3개는 유지)
  const minKeep = origModel.length + Math.min(atomPool.length, 3);
  while (parts.join(" ").length > MAX_LEN && parts.length > minKeep) {
    parts.pop();
  }

  // 동일 단어 3회 이상 반복 방지 (네이버 스마트스토어 등록 불가 방지)
  function countInText(text: string, sub: string): number {
    let cnt = 0, pos = 0;
    while ((pos = text.indexOf(sub, pos)) !== -1) { cnt++; pos += 1; }
    return cnt;
  }
  // 모든 atom에서 2자+ 한글 서브스트링 수집
  const checkSubs = new Set<string>();
  for (const p of parts) {
    const kr = p.replace(/[^가-힣]/g, "");
    for (let i = 0; i < kr.length; i++) {
      for (let j = i + 2; j <= kr.length; j++) checkSubs.add(kr.slice(i, j));
    }
  }
  // 3회 이상 반복되는 서브스트링 → 해당 atom 뒤에서부터 제거
  let needCheck = true;
  while (needCheck && parts.length > minKeep) {
    needCheck = false;
    const joined = parts.join("");
    for (const sub of checkSubs) {
      if (countInText(joined, sub) >= 3) {
        // 뒤에서부터 이 sub를 포함하는 atom 찾아서 제거
        for (let i = parts.length - 1; i >= minKeep; i--) {
          if (parts[i].includes(sub)) {
            parts.splice(i, 1);
            needCheck = true;
            break;
          }
        }
        if (needCheck) break;
      }
    }
  }

  const title = parts.join(" ");
  console.log(`[generate-title] "${productName}" → "${title}" (${title.length}자, cov:${coverageRatio})`);
  return new Response(JSON.stringify({ title, length: title.length, productName, coverage: coverageRatio, atoms: atomPool }), { headers: { ...cors, "Content-Type": "application/json" } });
}

// ── excel-fast: Gemini 1회 + 네이버 검색량만, 이미지/카테고리 필터 제거 ──
async function handleExcelFast(body: any, cors: Record<string, string>): Promise<Response> {
  const { productName, categoryName } = body;
  if (!productName || typeof productName !== "string" || productName.trim().length < 2) {
    return new Response(JSON.stringify({ error: "productName 필수", code: "INVALID_INPUT" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
  const pn = productName.trim();
  const catName = (typeof categoryName === "string") ? categoryName.trim() : "";
  const { tokens: coreTokens } = extractCoreKeywords(pn);
  console.log(`[excel-fast] "${pn}" | cat="${catName}" | tokens=${coreTokens.join(",")}`);

  // ── Gemini 1회 통합: 키워드 + 핵심어 + 동의어 + 수식어 → 조합까지 한번에 ──
  const catHint = catName ? `\n상품 카테고리: ${catName}\n반드시 이 카테고리와 직접 관련된 키워드만 생성하세요.` : "";
  const coreHint = coreTokens.length > 0 ? `\n핵심 키워드 힌트: [${coreTokens.join(", ")}]` : "";
  const prompt = `당신은 네이버 스마트스토어 SEO 전문가입니다.

상품명: "${pn}"${coreHint}${catHint}

이 상품을 네이버에서 검색할 때 소비자가 실제로 입력하는 키워드를 최대한 많이 생성하세요.

포함할 패턴:
1. [용도/상황]+[상품명] (예: 캠핑라면, 사무실의자)
2. [재료/특성]+[상품명] (예: 스테인리스냄비, 원목선반)
3. [방식/타입]+[상품명] (예: 충전드릴, 접이식테이블)
4. [상품명]+[형태] (예: 라면세트, 의자커버)
5. [대상]+[상품명] (예: 자취생라면, 아기의자)
6. 동의어/유사어 전부 (같은 상품의 다른 이름)
7. 1~6번의 조합 (수식어+핵심어+형태 등)

규칙:
- 띄어쓰기 없이 붙여쓰기
- 브랜드명/모델번호 제외
- 3글자 이상만
- 원본 상품과 동일한 카테고리 키워드만
- 최대 80개
- JSON 배열로만 반환`;

  let allKeywords: string[] = [...coreTokens];
  try {
    const data = await callGemini({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } } });
    const text = extractGeminiText(data) || "[]";
    const raw = parseJsonArray(text).filter((k: any) => typeof k === "string" && k.length >= 3);
    allKeywords = [...new Set([...raw, ...coreTokens])];
    console.log(`[excel-fast] Gemini: ${raw.length}개 → merged: ${allKeywords.length}개`);
  } catch (e) {
    console.error("[excel-fast] Gemini error:", e);
    return new Response(JSON.stringify({ error: "AI 키워드 생성 실패", code: "GEMINI_FAILED" }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // ── 기본 필터 (2자 이하 제거) ──
  const filtered = allKeywords.filter(k => k.replace(/\s/g, "").length > 2);

  // ── 네이버 검색량 조회 (기존 step3_checkVolume 재사용) ──
  const effectiveCategory = catName || "";
  const volumeResults = await step3_checkVolume(filtered, effectiveCategory);
  console.log(`[excel-fast] filtered=${filtered.length} → volume_passed=${volumeResults.length}`);

  // ── 코드 기반 카테고리 필터 (Gemini 대신): 상품명 토큰과 겹치지 않는 키워드 중 검색량 낮은 것만 제거 ──
  // (보수적: 검색량 50 이상이면 무조건 유지)
  const final = volumeResults.filter(v => {
    if (v.volume >= 50) return true;
    // 상품명 토큰 중 하나라도 키워드에 포함되면 유지
    const kwNorm = v.keyword.replace(/\s/g, "").toLowerCase();
    return coreTokens.some(t => kwNorm.includes(t.toLowerCase()));
  });

  const legacy = final.map(v => ({ keyword: v.keyword, volume: v.volume }));
  return new Response(JSON.stringify({
    productName: pn,
    step1_count: allKeywords.length,
    filter_count: filtered.length,
    naver_count: volumeResults.length,
    image_count: final.length,
    keywords: legacy,
    keywordsV2: final,
  }), { headers: { ...cors, "Content-Type": "application/json" } });
}

// ── v54: 시드 키워드 확장 — keyword_cache의 키워드를 네이버 API에 재투입해 연관 키워드 폭발적 수집 ──
async function expandSeeds(seeds: string[]): Promise<{ apiCalls: number; respondedKeywords: number; cacheItemsCount: number }> {
  const respondedSet = new Set<string>();
  const cacheItems: any[] = [];
  let apiCalls = 0;
  const PARALLEL = 3;

  const processBatch = async (batch: string[], batchIdx: number) => {
    const hint = batch.join(",");
    const uri = "/keywordstool";
    const timestamp = String(Date.now() + batchIdx);
    const sig = await naverSignature(timestamp, "GET", uri);
    const params = new URLSearchParams({ hintKeywords: hint, showDetail: "1" });
    try {
      const res = await fetch(`https://api.searchad.naver.com${uri}?${params}`, {
        headers: { "Content-Type": "application/json", "X-Timestamp": timestamp, "X-API-KEY": NAVER_API_KEY, "X-Customer": NAVER_CUSTOMER_ID, "X-Signature": sig },
      });
      apiCalls++;
      if (!res.ok) { console.warn(`[seed-expand] API ${res.status} batch ${batchIdx}`); return; }
      const data = await res.json();
      for (const kw of data?.keywordList || []) {
        if (respondedSet.has(kw.relKeyword)) continue;
        respondedSet.add(kw.relKeyword);
        const pcNum = parseCount(kw.monthlyPcQcCnt);
        const moNum = parseCount(kw.monthlyMobileQcCnt);
        const total = pcNum + moNum;
        const compIdx = kw.compIdx || "";
        const pcClk = Number(kw.monthlyAvPcClkCnt) || 0;
        const moClk = Number(kw.monthlyAvMobileClkCnt) || 0;
        const avgClk = pcClk + moClk || Number(kw.monthlyAvClkCnt) || 0;
        const pcCtr = Number(kw.monthlyAvPcCtr) || 0;
        const moCtr = Number(kw.monthlyAvMobileCtr) || 0;
        const avgCtr = moCtr > 0 ? moCtr : (pcCtr > 0 ? pcCtr : Number(kw.monthlyAvCtr) || 0);
        const adDepth = Number(kw.plAvgDepth) || 0;
        const { score, grade } = calcKQS(total, avgCtr, compIdx, adDepth);
        if (pcNum > 0 || moNum > 0) {
          cacheItems.push({
            keyword: kw.relKeyword,
            monthly_pc_qc_cnt: pcNum, monthly_mobile_qc_cnt: moNum, monthly_qc_cnt: total,
            comp_idx: compIdx, monthly_avg_clk_cnt: avgClk, monthly_avg_ctr: avgCtr, pl_avg_depth: adDepth,
            kqs_score: score, kqs_grade: grade,
            last_refreshed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          });
        }
      }
    } catch (e) { console.error(`[seed-expand] error batch ${batchIdx}:`, e); }
  };

  let batchCounter = 0;
  for (let i = 0; i < seeds.length; i += 5 * PARALLEL) {
    const promises: Promise<void>[] = [];
    for (let p = 0; p < PARALLEL; p++) {
      const start = i + p * 5;
      if (start >= seeds.length) break;
      promises.push(processBatch(seeds.slice(start, start + 5), batchCounter++));
    }
    await Promise.all(promises);
    if (i + 5 * PARALLEL < seeds.length) await new Promise(r => setTimeout(r, 300));
  }
  await upsertKeywordCache(cacheItems);
  return { apiCalls, respondedKeywords: respondedSet.size, cacheItemsCount: cacheItems.length };
}

// ── v54: refresh-stale — 30일+ 묵은 키워드 재호출하여 검색량 갱신 (네이버는 매월 1일 데이터 교체) ──
// 주의: 기존 캐시 조회/사용 흐름은 일체 건드리지 않음. 별도 함수로 격리.
async function handleRefreshStale(body: any, cors: any) {
  const { offset = 0, limit = 100, stale_days = 30 } = body;
  const cutoffMs = Date.now() - stale_days * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();

  // last_refreshed_at < cutoff 또는 NULL 인 키워드 추출 (검색량 큰 순)
  // NULL 처리: Postgres에서 비교 연산자는 NULL을 배제하므로 .or() 로 명시 처리
  const { data: stale, error } = await db
    .from("keyword_cache")
    .select("keyword, last_refreshed_at, monthly_qc_cnt")
    .or(`last_refreshed_at.is.null,last_refreshed_at.lt.${cutoff}`)
    .order("monthly_qc_cnt", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (!stale || stale.length === 0) {
    return new Response(JSON.stringify({ processed: 0, done: true, message: "no more stale keywords", cutoff }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  const staleKeywords = stale.map((s: any) => s.keyword);

  // before count
  const { count: beforeCount } = await db.from("keyword_cache").select("*", { count: "exact", head: true });

  // expandSeeds 재활용 — 네이버 응답의 연관 키워드를 upsert
  const result = await expandSeeds(staleKeywords);

  // 핵심 안전장치: 네이버 응답에 입력 키워드가 포함되지 않을 수 있음
  // → 입력 키워드의 last_refreshed_at은 명시적으로 강제 갱신해야 무한 루프 방지
  const now = new Date().toISOString();
  let touchedInputs = 0;
  for (let i = 0; i < staleKeywords.length; i += 100) {
    const batch = staleKeywords.slice(i, i + 100);
    const { error: touchErr, count } = await db
      .from("keyword_cache")
      .update({ last_refreshed_at: now }, { count: "exact" })
      .in("keyword", batch);
    if (touchErr) console.error("[refresh-stale] touch error:", touchErr.message);
    touchedInputs += (count || 0);
  }

  // after count
  const { count: afterCount } = await db.from("keyword_cache").select("*", { count: "exact", head: true });

  return new Response(JSON.stringify({
    offset, limit, stale_days, cutoff,
    stale_processed: staleKeywords.length,
    api_calls: result.apiCalls,
    naver_responses: result.respondedKeywords,
    upserts: result.cacheItemsCount,
    touched_inputs: touchedInputs,
    before_total: beforeCount,
    after_total: afterCount,
    new_keywords: (afterCount || 0) - (beforeCount || 0),
    // 중요: 처리된 stale 키워드는 자동으로 SQL 결과에서 빠지므로 next_offset은 항상 0
    // 클라이언트는 done:true 될 때까지 offset=0으로 반복 호출
    next_offset: 0,
    done: staleKeywords.length < limit,
  }), { headers: { ...cors, "Content-Type": "application/json" } });
}

async function handleSeedExpand(body: any, cors: any) {
  const { offset = 0, limit = 100, grades = ["S", "A"] } = body;
  const { data: seeds, error } = await db
    .from("keyword_cache")
    .select("keyword")
    .in("kqs_grade", grades)
    .order("kqs_score", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (!seeds || seeds.length === 0) {
    return new Response(JSON.stringify({ processed: 0, done: true, message: "no more seeds" }), { headers: { ...cors, "Content-Type": "application/json" } });
  }

  const seedKeywords = seeds.map((s: any) => s.keyword);
  const { count: beforeCount } = await db.from("keyword_cache").select("*", { count: "exact", head: true });
  const result = await expandSeeds(seedKeywords);
  const { count: afterCount } = await db.from("keyword_cache").select("*", { count: "exact", head: true });

  return new Response(JSON.stringify({
    offset, limit,
    seeds_processed: seedKeywords.length,
    api_calls: result.apiCalls,
    naver_responses: result.respondedKeywords,
    cache_items_eligible: result.cacheItemsCount,
    before_total: beforeCount,
    after_total: afterCount,
    new_keywords: (afterCount || 0) - (beforeCount || 0),
    next_offset: offset + limit,
    done: seedKeywords.length < limit,
  }), { headers: { ...cors, "Content-Type": "application/json" } });
}


const HTML_UI = "<!DOCTYPE html>\n<html lang=\"ko\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>keywordlab.ai — 키워드 최적화</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap\" rel=\"stylesheet\">\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js\"></script>\n<style>\n  :root {\n    --navy: #0F172A;\n    --navy-light: #1E293B;\n    --accent: #D4A853;\n    --accent-hover: #C49A38;\n    --red: #EF4444;\n    --green: #10B981;\n    --orange: #F59E0B;\n    --gray-50: #F8FAFC;\n    --gray-100: #F1F5F9;\n    --gray-200: #E2E8F0;\n    --gray-300: #CBD5E1;\n    --gray-400: #94A3B8;\n    --gray-500: #64748B;\n    --gray-600: #475569;\n    --gray-700: #334155;\n    --gray-900: #0F172A;\n    --radius: 12px;\n    --shadow-sm: 0 1px 2px rgba(0,0,0,.05);\n    --shadow: 0 4px 24px rgba(0,0,0,.06);\n    --shadow-lg: 0 12px 40px rgba(0,0,0,.1);\n  }\n  * { box-sizing: border-box; margin: 0; padding: 0; }\n  body {\n    font-family: 'Inter', -apple-system, 'Apple SD Gothic Neo', sans-serif;\n    background: var(--gray-50);\n    color: var(--gray-900);\n    line-height: 1.6;\n    -webkit-font-smoothing: antialiased;\n    min-height: 100vh;\n    display: flex;\n    flex-direction: column;\n  }\n\n  /* ── Nav ── */\n  .nav {\n    background: rgba(15,23,42,.97);\n    backdrop-filter: blur(12px);\n    -webkit-backdrop-filter: blur(12px);\n    color: #fff;\n    padding: 0 32px;\n    height: 56px;\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    position: sticky; top: 0; z-index: 100;\n    border-bottom: 1px solid rgba(255,255,255,.06);\n  }\n  .nav-brand {\n    font-size: 18px; font-weight: 800; cursor: pointer;\n    letter-spacing: -.3px;\n    display: flex; align-items: center; gap: 2px;\n  }\n  .nav-brand .dot { color: var(--accent); }\n  .nav-center { display: flex; gap: 2px; }\n  .nav-link {\n    color: var(--gray-400); font-size: 13px; font-weight: 500;\n    cursor: pointer; text-decoration: none;\n    padding: 6px 14px; border-radius: 6px;\n    transition: all .15s;\n  }\n  .nav-link:hover { color: #fff; background: rgba(255,255,255,.07); }\n  .nav-link.on { color: #fff; background: rgba(212,168,83,.25); }\n  .nav-right { display: flex; align-items: center; gap: 10px; }\n  .nav-credit {\n    display: flex; align-items: center; gap: 8px;\n    background: rgba(255,255,255,.06);\n    padding: 5px 6px 5px 12px;\n    border-radius: 8px; font-size: 12px; color: var(--gray-400);\n  }\n  .nav-credit b { color: #fff; font-weight: 700; }\n  .nav-credit .ch-btn {\n    background: var(--accent); color: #fff; border: none;\n    padding: 3px 10px; border-radius: 5px;\n    font-size: 11px; font-weight: 600; cursor: pointer;\n    transition: background .15s;\n  }\n  .nav-credit .ch-btn:hover { background: var(--accent-hover); }\n  .nav-logout {\n    background: none; border: none; color: var(--gray-500);\n    cursor: pointer; font-size: 14px; padding: 4px 6px; border-radius: 4px;\n    transition: color .15s;\n  }\n  .nav-logout:hover { color: #fff; }\n\n  /* ── Buttons ── */\n  .btn {\n    display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n    font-weight: 600; border: none; border-radius: 8px;\n    cursor: pointer; transition: all .15s; font-family: inherit;\n  }\n  .btn-primary { background: var(--accent); color: #fff; }\n  .btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(212,168,83,.35); }\n  .btn-dark { background: var(--navy); color: #fff; }\n  .btn-dark:hover { background: var(--navy-light); }\n  .btn-sm { padding: 7px 16px; font-size: 12px; }\n  .btn-md { padding: 10px 22px; font-size: 13px; }\n  .btn-lg { padding: 14px 32px; font-size: 15px; border-radius: 10px; }\n\n  /* ── Layout ── */\n  .container { max-width: 1200px; margin: 0 auto; padding: 32px 40px; flex: 1; }\n  .card {\n    background: #fff; border-radius: var(--radius);\n    box-shadow: var(--shadow-sm);\n    border: 1px solid var(--gray-200);\n  }\n\n  /* ── Tabs ── */\n  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--gray-200); margin-bottom: 16px; }\n  .tab {\n    padding: 10px 18px; font-size: 13px; font-weight: 500;\n    color: var(--gray-400); border-bottom: 2px solid transparent;\n    margin-bottom: -1px; cursor: pointer; transition: all .15s;\n  }\n  .tab:hover { color: var(--gray-700); }\n  .tab.on { color: var(--accent); font-weight: 600; border-bottom-color: var(--accent); }\n\n  /* ── Stats ── */\n  .stat-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 16px; margin-bottom: 24px; }\n  .stat-card {\n    background: #fff; border-radius: 10px; padding: 18px 16px;\n    border: 1px solid var(--gray-200);\n  }\n  .stat-label { font-size: 11px; color: var(--gray-400); font-weight: 500; text-transform: uppercase; letter-spacing: .5px; }\n  .stat-value { font-size: 26px; font-weight: 700; margin-top: 4px; }\n  .stat-sub { font-size: 11px; color: var(--gray-400); margin-top: 2px; }\n\n  /* ── Table ── */\n  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }\n  .tbl thead { background: var(--gray-50); }\n  .tbl th {\n    text-align: left; padding: 10px 16px; font-size: 11px;\n    color: var(--gray-400); font-weight: 600; text-transform: uppercase; letter-spacing: .3px;\n  }\n  .tbl td { padding: 12px 16px; border-top: 1px solid var(--gray-100); }\n  .tbl tbody tr:hover { background: var(--gray-50); }\n\n  /* ── KQS ── */\n  .kqs { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; color: #fff; }\n  .kqs-s { background: var(--green); }\n  .kqs-a { background: #059669; }\n  .kqs-b { background: var(--orange); }\n  .kqs-c { background: var(--gray-400); }\n  .kqs-d { background: var(--gray-300); color: var(--gray-600); }\n\n  /* ── Upload ── */\n  .upload-zone {\n    border: 2px dashed var(--gray-300); border-radius: 12px;\n    padding: 40px 20px; text-align: center;\n    background: var(--gray-50); cursor: pointer; transition: all .2s;\n  }\n  .upload-zone:hover, .upload-zone.dragover { border-color: var(--accent); background: #FDF8EE; }\n\n  /* ── Footer ── */\n  .foot {\n    text-align: center; padding: 32px 24px 24px;\n    font-size: 12px; color: var(--gray-400);\n    border-top: 1px solid var(--gray-200); background: #fff;\n    line-height: 2;\n  }\n  .foot a { color: var(--gray-500); cursor: pointer; text-decoration: none; margin: 0 8px; }\n  .foot a:hover { color: var(--accent); }\n\n  /* ── Functional additions (light theme) ── */\n  .single-status { text-align: center; padding: 20px; color: var(--gray-500); font-size: 14px; display: none; }\n  .single-status.show { display: block; }\n  .single-summary { display: none; }\n  .single-summary.show { display: block; }\n  .pipeline-text { font-size: 13px; color: var(--gray-500); margin-top: 8px; }\n  .pipeline-text strong { color: var(--navy); }\n  .grade-summary { display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap; }\n  .grade-summary .gs-item { font-size: 12px; color: var(--gray-500); }\n  .grade-summary .gs-item strong { margin-left: 4px; }\n  .kw-table-wrap { display: none; overflow: hidden; border: 1px solid var(--gray-100); border-radius: 8px; }\n  .kw-table-wrap.show { display: block; }\n\n  .file-info { display: none; margin-top: 16px; }\n  .file-info.show { display: block; }\n  .file-name { font-weight: 600; font-size: 14px; margin-bottom: 12px; color: var(--navy); }\n\n  .mode-bar { display: flex; gap: 10px; margin-top: 14px; font-size: 13px; }\n  .mode-label {\n    flex: 1; border: 1px solid var(--gray-200); padding: 10px; border-radius: 8px;\n    cursor: pointer; text-align: center; transition: border .15s; color: var(--gray-500);\n    display: flex; align-items: center; justify-content: center; gap: 6px;\n  }\n  .mode-label:hover { border-color: var(--accent); color: var(--gray-700); }\n  .mode-label.selected { border-color: var(--accent); color: var(--accent-hover); background: #FDF8EE; }\n\n  .btn-start {\n    width: 100%; padding: 14px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600;\n    cursor: pointer; background: var(--accent); color: #fff;\n    margin-top: 14px; display: none; transition: all .15s; font-family: inherit;\n  }\n  .btn-start:hover { background: var(--accent-hover); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(212,168,83,.35); }\n  .btn-start:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }\n  .btn-start.show { display: block; }\n\n  .progress-section { display: none; margin-top: 16px; background: var(--gray-50); border-radius: 8px; padding: 16px; }\n  .progress-section.show { display: block; }\n  .progress-header { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 8px; }\n  .progress-header .label { color: var(--navy); font-weight: 600; }\n  .progress-header .pct { color: var(--accent); font-weight: 600; }\n  .progress-bar-wrap { height: 8px; background: var(--gray-200); border-radius: 4px; overflow: hidden; margin-bottom: 8px; }\n  .progress-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #E0BC6A); border-radius: 4px; transition: width 0.3s; width: 0%; }\n  .progress-sub { font-size: 11px; color: var(--gray-400); margin-bottom: 12px; }\n\n  .product-list { list-style: none; max-height: 300px; overflow-y: auto; }\n  .product-item {\n    background: #fff; border-radius: 8px; padding: 10px 14px; margin-bottom: 6px;\n    display: flex; align-items: center; gap: 10px; font-size: 13px;\n    border: 1px solid var(--gray-100);\n  }\n  .product-item .status-icon { font-size: 16px; width: 22px; text-align: center; }\n  .product-item .name { flex: 1; color: var(--navy); }\n  .product-item .kw-count { color: var(--accent); font-weight: 600; font-size: 12px; }\n\n  @keyframes spin { to { transform: rotate(360deg); } }\n  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--gray-200); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }\n\n  .btn-download {\n    width: 100%; padding: 14px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600;\n    cursor: pointer; background: var(--navy); color: #fff;\n    display: none; transition: all .15s; font-family: inherit; margin-top: 12px;\n  }\n  .btn-download:hover { background: var(--navy-light); transform: translateY(-1px); }\n  .btn-download.show { display: block; }\n\n  .log {\n    margin-top: 24px; background: #fff; border: 1px solid var(--gray-200); border-radius: 10px;\n    padding: 16px; font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px; color: var(--gray-500);\n    max-height: 200px; overflow-y: auto; display: none;\n  }\n  .log.show { display: block; }\n  .log .info { color: var(--gray-500); }\n  .log .success { color: var(--green); }\n  .log .error { color: var(--red); }\n\n  /* ── Responsive ── */\n  @media (max-width: 768px) {\n    .container { padding: 20px 16px; }\n    .nav { padding: 0 16px; }\n    .nav-center { display: none; }\n    .tbl th:nth-child(5), .tbl td:nth-child(5),\n    .tbl th:nth-child(6), .tbl td:nth-child(6) { display: none; }\n  }\n</style>\n</head>\n<body>\n\n<!-- ── Nav (목업 그대로) ── -->\n<div class=\"nav\">\n  <div class=\"nav-brand\">keywordlab<span class=\"dot\">.ai</span></div>\n  <div class=\"nav-center\">\n    <a class=\"nav-link on\">키워드 검색</a>\n    <a class=\"nav-link\">키워드 기록</a>\n    <a class=\"nav-link\">업무 기록</a>\n  </div>\n  <div class=\"nav-right\">\n    <div class=\"nav-credit\">잔액 <b>847</b>건 <button class=\"ch-btn\">충전</button></div>\n    <button class=\"nav-logout\" title=\"로그아웃\">⏻</button>\n  </div>\n</div>\n\n<!-- ── Main Container ── -->\n<div class=\"container\">\n  <!-- 검색 도구 (목업 구조 그대로) -->\n  <div class=\"card\" style=\"padding:24px;border:1.5px solid var(--accent);box-shadow:0 4px 20px rgba(212,168,83,.08);margin-bottom:20px\">\n    <div class=\"tabs\" style=\"margin-bottom:18px\" id=\"mainTabs\">\n      <div class=\"tab on\" data-tab=\"single\">🔍 단일 분석</div>\n      <div class=\"tab\" data-tab=\"bulk\">📊 엑셀 일괄</div>\n    </div>\n\n    <!-- ── 단일 분석 ── -->\n    <div id=\"tool-single\">\n      <p style=\"font-size:13px;color:var(--gray-500);margin-bottom:14px\"></p>\n      <div style=\"display:flex;gap:10px;margin-bottom:18px\">\n        <input type=\"text\" id=\"singleKeyword\" placeholder=\"상품 키워드를 입력하세요 (예: 자동차커버)\" style=\"flex:1;padding:12px 14px;border:1px solid var(--accent);border-radius:8px;font-size:13px;font-family:inherit\">\n        <button class=\"btn btn-primary btn-md\" id=\"btnSearch\">분석</button>\n      </div>\n\n      <!-- 분석 중 상태 -->\n      <div class=\"single-status\" id=\"singleStatus\">\n        <span class=\"spinner\"></span>&nbsp; 자체 AI 엔진 분석 + 네이버 검증 중... 약 8초 소요\n      </div>\n\n      <!-- 분석 결과 요약 -->\n      <div class=\"single-summary\" id=\"singleSummary\">\n        <div style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px\">\n          <div style=\"background:var(--gray-50);border-radius:8px;padding:14px;text-align:center\">\n            <div style=\"font-size:11px;color:var(--gray-400);margin-bottom:4px\">추출 키워드</div>\n            <div style=\"font-size:22px;font-weight:800;color:var(--navy)\" id=\"singleTotal\">0</div>\n          </div>\n          <div style=\"background:var(--gray-50);border-radius:8px;padding:14px;text-align:center\">\n            <div style=\"font-size:11px;color:var(--gray-400);margin-bottom:4px\">최고 검색량</div>\n            <div style=\"font-size:22px;font-weight:800;color:var(--accent)\" id=\"singleTopVol\">0</div>\n          </div>\n          <div style=\"background:var(--gray-50);border-radius:8px;padding:14px;text-align:center\">\n            <div style=\"font-size:11px;color:var(--gray-400);margin-bottom:4px\">S/A 등급</div>\n            <div style=\"font-size:22px;font-weight:800;color:var(--green)\" id=\"singleSGrade\">-</div>\n          </div>\n        </div>\n        <div class=\"pipeline-text\" id=\"pipelineText\"></div>\n        <div class=\"grade-summary\" id=\"gradeSummary\"></div>\n      </div>\n\n      <!-- 결과 테이블 -->\n      <div class=\"kw-table-wrap\" id=\"kwTableWrap\">\n        <table class=\"tbl\" style=\"table-layout:fixed\">\n          <thead><tr>\n            <th style=\"width:5%;text-align:center\">#</th>\n            <th style=\"width:10%;text-align:center\">등급</th>\n            <th style=\"width:25%\">키워드</th>\n            <th style=\"width:15%;text-align:right\">검색량</th>\n            <th style=\"width:15%;text-align:right\">경쟁도</th>\n            <th style=\"width:12%;text-align:right\">CTR</th>\n            <th style=\"width:18%\">전략</th>\n          </tr></thead>\n          <tbody id=\"kwTableBody\"></tbody>\n        </table>\n      </div>\n\n      <div style=\"display:flex;justify-content:space-between;align-items:center;margin-top:12px\">\n        <span id=\"singleFooterText\" style=\"font-size:12px;color:var(--gray-400);display:none\"></span>\n        <button class=\"btn btn-dark btn-sm\" id=\"btnCopyKw\" style=\"font-size:12px;display:none\">📋 키워드 전체 복사</button>\n      </div>\n    </div>\n\n    <!-- ── 엑셀 일괄 ── -->\n    <div id=\"tool-bulk\" style=\"display:none\">\n      <p style=\"font-size:13px;color:var(--gray-500);margin-bottom:14px\"></p>\n      <div class=\"upload-zone\" id=\"dropzone\">\n        <div style=\"font-size:32px;margin-bottom:8px\">📁</div>\n        <div style=\"font-size:14px;color:var(--navy);font-weight:600\">엑셀 파일을 끌어놓거나 클릭</div>\n        <div style=\"font-size:12px;color:var(--gray-400);margin-top:4px\">.xlsx · 최대 1만 상품</div>\n        <input type=\"file\" id=\"fileInput\" accept=\".xlsx,.xls\" style=\"display:none\">\n      </div>\n\n      <!-- 양식 선택 (목업 그대로) -->\n      <div style=\"display:flex;gap:10px;margin-top:14px;font-size:13px\">\n        <label style=\"flex:1;border:1px solid var(--gray-200);padding:10px;border-radius:8px;cursor:pointer;text-align:center;transition:border .15s\" onmouseover=\"this.style.borderColor='var(--accent)'\" onmouseout=\"this.style.borderColor='var(--gray-200)'\"><input type=\"radio\" name=\"fmt\" checked style=\"margin-right:6px\">UPlat</label>\n        <label style=\"flex:1;border:1px solid var(--gray-200);padding:10px;border-radius:8px;text-align:center;opacity:.4;cursor:not-allowed\"><input type=\"radio\" name=\"fmt\" disabled style=\"margin-right:6px\">사방넷 <span style=\"font-size:10px;color:var(--gray-400)\">(준비중)</span></label>\n        <label style=\"flex:1;border:1px solid var(--gray-200);padding:10px;border-radius:8px;text-align:center;opacity:.4;cursor:not-allowed\"><input type=\"radio\" name=\"fmt\" disabled style=\"margin-right:6px\">샵링커 <span style=\"font-size:10px;color:var(--gray-400)\">(준비중)</span></label>\n      </div>\n\n      <!-- 파일 로드 후 통계 -->\n      <div class=\"file-info\" id=\"fileInfo\">\n        <div class=\"file-name\" id=\"fileName\"></div>\n        <div style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px\">\n          <div style=\"background:var(--gray-50);border-radius:8px;padding:14px;text-align:center\">\n            <div style=\"font-size:11px;color:var(--gray-400);margin-bottom:4px\">전체 행</div>\n            <div style=\"font-size:22px;font-weight:800;color:var(--navy)\" id=\"totalRows\">0</div>\n          </div>\n          <div style=\"background:var(--gray-50);border-radius:8px;padding:14px;text-align:center\">\n            <div style=\"font-size:11px;color:var(--gray-400);margin-bottom:4px\">고유 상품</div>\n            <div style=\"font-size:22px;font-weight:800;color:var(--accent)\" id=\"uniqueProducts\">0</div>\n          </div>\n          <div style=\"background:var(--gray-50);border-radius:8px;padding:14px;text-align:center\">\n            <div style=\"font-size:11px;color:var(--gray-400);margin-bottom:4px\">예상 시간</div>\n            <div style=\"font-size:22px;font-weight:800;color:var(--orange)\" id=\"estTime\">0</div>\n          </div>\n        </div>\n      </div>\n\n      <!-- 모드 선택 -->\n      <div class=\"mode-bar\" id=\"modeBar\" style=\"display:none\">\n        <label class=\"mode-label\" id=\"modeFast\">\n          <input type=\"radio\" name=\"excelMode\" value=\"fast\" style=\"display:none\"> ⚡ 빠른 모드 (~10분/1000건)\n        </label>\n        <label class=\"mode-label selected\" id=\"modeNormal\">\n          <input type=\"radio\" name=\"excelMode\" value=\"normal\" checked style=\"display:none\"> 🔍 정밀 모드 (~46분/1000건)\n        </label>\n      </div>\n\n      <!-- 모드 안내 (목업 그대로) -->\n      <div id=\"modeInfo\" style=\"display:none;margin-top:14px;background:#FDF8EE;border:1px solid #F0E0C0;border-radius:8px;padding:12px 16px;font-size:13px;display:flex;align-items:center;gap:8px\">\n        <span style=\"font-size:16px\">🔍</span>\n        <span><b style=\"color:var(--accent-hover)\">정밀 모드</b> <span style=\"color:var(--gray-500)\">· AI 키워드 확장 + 네이버 검색량 + 경쟁도 + CTR → KQS 등급</span></span>\n      </div>\n\n      <!-- 시작 버튼 -->\n      <button class=\"btn-start\" id=\"btnStart\">🚀 키워드 최적화 시작</button>\n\n      <!-- 진행 상태 (목업 스타일) -->\n      <div class=\"progress-section\" id=\"progressSection\">\n        <div class=\"progress-header\">\n          <span class=\"label\" id=\"progressLabel\">처리 중...</span>\n          <span class=\"pct\" id=\"progressPct\">0%</span>\n        </div>\n        <div class=\"progress-bar-wrap\"><div class=\"progress-bar\" id=\"progressBar\"></div></div>\n        <div class=\"progress-sub\" id=\"progressSub\"></div>\n        <ul class=\"product-list\" id=\"productList\"></ul>\n      </div>\n\n      <!-- 다운로드 버튼 -->\n      <button class=\"btn-download\" id=\"btnDownload\">📥 결과 엑셀 다운로드</button>\n    </div>\n  </div>\n\n  <!-- Stats (목업 그대로) -->\n  <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:12px\">\n    <div class=\"stat-card\"><div class=\"stat-label\">잔액</div><div class=\"stat-value\" style=\"color:var(--navy)\">847</div><div class=\"stat-sub\">상품 처리 가능</div></div>\n    <div class=\"stat-card\"><div class=\"stat-label\">이번 달 처리</div><div class=\"stat-value\" style=\"color:var(--navy)\">--</div><div class=\"stat-sub\">상품</div></div>\n  </div>\n\n  <!-- Log -->\n  <div class=\"log\" id=\"log\"></div>\n</div>\n\n<!-- ── Footer (목업 그대로) ── -->\n<div class=\"foot\">© 2026 keywordlab.ai · 덕우무역(주) <a>이용약관</a><a>개인정보처리방침</a></div>\n\n<script>\nconst API_URL = \"https://uifjabklkmvfbsplvxsu.supabase.co/functions/v1/keyword-tool\";\n\n// ========================\n// HELPERS\n// ========================\nfunction gradeClass(g) {\n  if (g === \"S\") return \"kqs-s\";\n  if (g === \"A\") return \"kqs-a\";\n  if (g === \"B\") return \"kqs-b\";\n  if (g === \"C\") return \"kqs-c\";\n  return \"kqs-d\";\n}\nfunction compLabel(c) {\n  if (c === \"낮음\") return \"낮음\";\n  if (c === \"높음\") return \"높음\";\n  return \"보통\";\n}\nfunction compColor(c) {\n  if (c === \"낮음\") return \"var(--green)\";\n  if (c === \"높음\") return \"var(--red)\";\n  return \"var(--orange)\";\n}\nfunction stratText(grade) {\n  if (grade === \"S\") return \"메인 키워드\";\n  if (grade === \"A\") return \"서브 키워드\";\n  if (grade === \"B\") return \"카테고리 확장\";\n  if (grade === \"C\") return \"롱테일\";\n  return \"모니터링\";\n}\n\n// ========================\n// TAB SWITCHING\n// ========================\ndocument.querySelectorAll(\"#mainTabs .tab\").forEach(tab => {\n  tab.addEventListener(\"click\", function() {\n    document.querySelectorAll(\"#mainTabs .tab\").forEach(t => t.classList.remove(\"on\"));\n    this.classList.add(\"on\");\n    const target = this.dataset.tab;\n    document.getElementById(\"tool-single\").style.display = target === \"single\" ? \"block\" : \"none\";\n    document.getElementById(\"tool-bulk\").style.display = target === \"bulk\" ? \"block\" : \"none\";\n  });\n});\n\n// ========================\n// MODE SWITCHING\n// ========================\ndocument.querySelectorAll(\".mode-label\").forEach(label => {\n  label.addEventListener(\"click\", function() {\n    document.querySelectorAll(\".mode-label\").forEach(l => l.classList.remove(\"selected\"));\n    this.classList.add(\"selected\");\n    this.querySelector(\"input[type=radio]\").checked = true;\n  });\n});\n\n// ========================\n// TAB 1: SINGLE KEYWORD\n// ========================\nconst singleInput = document.getElementById(\"singleKeyword\");\nconst btnSearch = document.getElementById(\"btnSearch\");\nconst singleStatus = document.getElementById(\"singleStatus\");\nconst singleSummary = document.getElementById(\"singleSummary\");\nconst kwTableWrap = document.getElementById(\"kwTableWrap\");\nconst kwTableBody = document.getElementById(\"kwTableBody\");\nconst btnCopyKw = document.getElementById(\"btnCopyKw\");\nconst singleFooterText = document.getElementById(\"singleFooterText\");\n\nlet singleKeywords = [];\n\nsingleInput.addEventListener(\"keydown\", (e) => { if (e.key === \"Enter\") btnSearch.click(); });\n\nbtnSearch.addEventListener(\"click\", async () => {\n  const keyword = singleInput.value.trim();\n  if (!keyword) { singleInput.focus(); return; }\n\n  btnSearch.disabled = true;\n  btnSearch.textContent = \"분석 중...\";\n  singleStatus.classList.add(\"show\");\n  singleSummary.classList.remove(\"show\");\n  kwTableWrap.classList.remove(\"show\");\n  btnCopyKw.style.display = \"none\";\n  singleFooterText.style.display = \"none\";\n  logEl.classList.add(\"show\");\n  log(`단일 키워드 분석 시작: \"${keyword}\"`, \"info\");\n\n  try {\n    const res = await fetch(API_URL, {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ productName: keyword, mode: \"single\" }),\n    });\n    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);\n    const data = await res.json();\n    singleKeywords = data.keywords || [];\n\n    // Summary\n    document.getElementById(\"singleTotal\").textContent = singleKeywords.length;\n    const topVol = singleKeywords.length > 0 ? singleKeywords[0].volume.toLocaleString() : \"0\";\n    document.getElementById(\"singleTopVol\").textContent = topVol;\n    const saCount = singleKeywords.filter(k => k.kqs_grade === \"S\" || k.kqs_grade === \"A\").length;\n    document.getElementById(\"singleSGrade\").textContent = saCount;\n    document.getElementById(\"pipelineText\").innerHTML =\n      `<strong>Step 1</strong> AI 생성 ${data.step1_count}개 → <strong>필터</strong> ${data.filter_count}개 → <strong>최종</strong> ${singleKeywords.length}개 KQS 등급 산출`;\n\n    // Grade summary\n    const grades = { S: 0, A: 0, B: 0, C: 0, D: 0 };\n    singleKeywords.forEach(k => { if (grades[k.kqs_grade] !== undefined) grades[k.kqs_grade]++; });\n    document.getElementById(\"gradeSummary\").innerHTML = Object.entries(grades)\n      .filter(([, v]) => v > 0)\n      .map(([g, v]) => `<span class=\"gs-item\"><span class=\"kqs ${gradeClass(g)}\">${g}</span><strong>${v}</strong></span>`)\n      .join(\"\");\n    singleSummary.classList.add(\"show\");\n\n    // Table (목업 스타일 그대로)\n    kwTableBody.innerHTML = singleKeywords.map((kw, i) => {\n      const ctrPct = (kw.avg_ctr * 100).toFixed(1);\n      return `<tr>\n        <td style=\"text-align:center\">${i + 1}</td>\n        <td style=\"text-align:center\"><span class=\"kqs ${gradeClass(kw.kqs_grade)}\">${kw.kqs_grade}</span></td>\n        <td style=\"font-weight:600\">${kw.keyword}</td>\n        <td style=\"text-align:right\">${kw.volume.toLocaleString()}</td>\n        <td style=\"text-align:right;color:${compColor(kw.comp_idx)}\">${compLabel(kw.comp_idx)}</td>\n        <td style=\"text-align:right\">${ctrPct}%</td>\n        <td style=\"font-size:12px;color:var(--gray-500)\">${stratText(kw.kqs_grade)}</td>\n      </tr>`;\n    }).join(\"\");\n    kwTableWrap.classList.add(\"show\");\n    btnCopyKw.style.display = \"inline-flex\";\n\n    // Footer text\n    singleFooterText.textContent = `총 ${singleKeywords.length}개 키워드 · S등급 ${grades.S} · A등급 ${grades.A}`;\n    singleFooterText.style.display = \"inline\";\n\n    log(`완료: AI ${data.step1_count}개 → 필터 ${data.filter_count}개 → KQS ${singleKeywords.length}개 (S:${grades.S} A:${grades.A} B:${grades.B} C:${grades.C} D:${grades.D})`, \"success\");\n  } catch (err) {\n    log(`오류: ${err.message}`, \"error\");\n  } finally {\n    singleStatus.classList.remove(\"show\");\n    btnSearch.disabled = false;\n    btnSearch.textContent = \"분석\";\n  }\n});\n\nbtnCopyKw.addEventListener(\"click\", () => {\n  if (!singleKeywords.length) return;\n  const text = singleKeywords.map(k => k.keyword).join(\", \");\n  navigator.clipboard.writeText(text).then(() => {\n    btnCopyKw.textContent = \"✅ 복사됨!\";\n    setTimeout(() => { btnCopyKw.textContent = \"📋 키워드 전체 복사\"; }, 2000);\n  }).catch(() => {\n    const ta = document.createElement(\"textarea\");\n    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand(\"copy\"); document.body.removeChild(ta);\n    btnCopyKw.textContent = \"✅ 복사됨!\";\n    setTimeout(() => { btnCopyKw.textContent = \"📋 키워드 전체 복사\"; }, 2000);\n  });\n});\n\n// ========================\n// TAB 2: EXCEL BULK\n// ========================\nlet workbook = null, sheetData = [], productGroups = [];\n\nconst dropzone = document.getElementById(\"dropzone\");\nconst fileInput = document.getElementById(\"fileInput\");\nconst fileInfo = document.getElementById(\"fileInfo\");\nconst btnStart = document.getElementById(\"btnStart\");\nconst progressSection = document.getElementById(\"progressSection\");\nconst productList = document.getElementById(\"productList\");\nconst progressBar = document.getElementById(\"progressBar\");\nconst btnDownload = document.getElementById(\"btnDownload\");\nconst logEl = document.getElementById(\"log\");\n\ndropzone.addEventListener(\"click\", () => fileInput.click());\ndropzone.addEventListener(\"dragover\", (e) => { e.preventDefault(); dropzone.classList.add(\"dragover\"); });\ndropzone.addEventListener(\"dragleave\", () => dropzone.classList.remove(\"dragover\"));\ndropzone.addEventListener(\"drop\", (e) => {\n  e.preventDefault(); dropzone.classList.remove(\"dragover\");\n  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);\n});\nfileInput.addEventListener(\"change\", (e) => { if (e.target.files.length) handleFile(e.target.files[0]); });\n\nfunction handleFile(file) {\n  log(`파일 로드: ${file.name}`, \"info\");\n  logEl.classList.add(\"show\");\n  const reader = new FileReader();\n  reader.onload = async (e) => {\n    workbook = XLSX.read(e.target.result, { type: \"array\" });\n    const sheet = workbook.Sheets[workbook.SheetNames[0]];\n    sheetData = XLSX.utils.sheet_to_json(sheet, { header: 1 });\n    const colD = 3, colE = 4, colB = 1, colM = 12, colT = 19;\n    const groups = {};\n    for (let i = 1; i < sheetData.length; i++) {\n      const row = sheetData[i];\n      const code = row[colB] || `row_${i}`;\n      if (!groups[code]) groups[code] = { code, name: row[colE] || row[colD] || \"\", imageUrl: row[colM] || \"\", categoryName: row[colT] || \"\", rows: [], keywords: null };\n      groups[code].rows.push(i);\n    }\n    productGroups = Object.values(groups);\n    document.getElementById(\"fileName\").textContent = `📄 ${file.name}`;\n    document.getElementById(\"totalRows\").textContent = (sheetData.length - 1).toLocaleString();\n    document.getElementById(\"uniqueProducts\").textContent = productGroups.length.toLocaleString();\n    document.getElementById(\"estTime\").textContent = `~${Math.ceil(productGroups.length / 5 * 13)}초`;\n    fileInfo.classList.add(\"show\");\n    document.getElementById(\"modeBar\").style.display = \"flex\";\n    document.getElementById(\"modeInfo\").style.display = \"flex\";\n    btnStart.classList.add(\"show\");\n    log(`${productGroups.length}개 고유 상품 감지`, \"success\");\n\n    // ── 마이카테 코드 → 카테고리명 변환 (jj2_category 테이블) ──\n    const catCodes = [...new Set(productGroups.map(g => g.categoryName).filter(c => c && /^[A-Z]?\\d+/.test(c)))];\n    if (catCodes.length > 0) {\n      log(`마이카테 조회 중...`, \"info\");\n      try {\n        const SB_URL = \"https://uifjabklkmvfbsplvxsu.supabase.co\";\n        const SB_KEY = \"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpZmphYmtsa212ZmJzcGx2eHN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxNDMwOTEsImV4cCI6MjA4OTcxOTA5MX0.1_rWJ0RDk_KXw86ewRq-F9DKIj6D7oaCzRWlrImzu2M\";\n        const codeFilter = catCodes.map(c => `\"${c}\"`).join(\",\");\n        const catRes = await fetch(`${SB_URL}/rest/v1/jj2_category?category_code=in.(${codeFilter})&select=category_code,category_name`, {\n          headers: { \"apikey\": SB_KEY, \"Authorization\": `Bearer ${SB_KEY}` }\n        });\n        if (catRes.ok) {\n          const catData = await catRes.json();\n          const catMap = {};\n          for (const row of catData) catMap[row.category_code] = row.category_name;\n          let mapped = 0;\n          for (const g of productGroups) {\n            if (g.categoryName && catMap[g.categoryName]) {\n              g.categoryName = catMap[g.categoryName];\n              mapped++;\n            }\n          }\n          log(`카테고리 조회 완료 — ${mapped}개 코드 매핑`, \"success\");\n        }\n      } catch (e) { log(`카테고리 조회 실패 (무시): ${e.message}`, \"error\"); }\n    }\n  };\n  reader.readAsArrayBuffer(file);\n}\n\nbtnStart.addEventListener(\"click\", async () => {\n  btnStart.disabled = true; btnStart.textContent = \"처리 중...\";\n  progressSection.classList.add(\"show\"); logEl.classList.add(\"show\");\n\n  productList.innerHTML = productGroups.map((g, i) => `\n    <li class=\"product-item\" id=\"prod-${i}\">\n      <span class=\"status-icon\">⬜</span><span class=\"name\">${g.name}</span>\n      <span class=\"kw-count\" id=\"kwcount-${i}\"></span>\n    </li>`).join(\"\");\n\n  const delay = (ms) => new Promise(r => setTimeout(r, ms));\n  const MAX_RETRIES = 2;\n  const RETRY_DELAY = 8000;\n  const CONCURRENCY = 5;\n\n  const excelMode = document.querySelector('input[name=\"excelMode\"]:checked')?.value || \"normal\";\n  log(`모드: ${excelMode === \"fast\" ? \"빠른 모드\" : \"정밀 모드\"}`, \"info\");\n\n  async function processOne(g) {\n    const payload = excelMode === \"fast\"\n      ? { action: \"excel-fast\", productName: g.name, categoryName: g.categoryName }\n      : { productName: g.name, imageUrl: g.imageUrl, categoryName: g.categoryName };\n    const res = await fetch(API_URL, {\n      method: \"POST\", headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify(payload),\n    });\n    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);\n    return await res.json();\n  }\n\n  let completed = 0;\n  const failedItems = [];\n\n  async function processWithRetry(g, idx) {\n    const el = document.getElementById(`prod-${idx}`);\n    const kwEl = document.getElementById(`kwcount-${idx}`);\n    el.querySelector(\".status-icon\").innerHTML = '<span class=\"spinner\"></span>';\n\n    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {\n      if (attempt > 0) {\n        kwEl.textContent = `재시도 ${attempt}/${MAX_RETRIES}`;\n        await delay(RETRY_DELAY);\n        el.querySelector(\".status-icon\").innerHTML = '<span class=\"spinner\"></span>';\n      }\n      try {\n        const data = await processOne(g);\n        g.keywords = data.keywords || [];\n        const fc = data.filter_count !== undefined ? data.filter_count : \"?\";\n        const nc = data.naver_count !== undefined ? data.naver_count : \"?\";\n        const ic = data.image_count !== undefined ? data.image_count : g.keywords.length;\n        kwEl.textContent = `${data.step1_count}→${fc}→${nc}→${ic}개`;\n        log(`키워드 완료: ${g.name} — AI ${data.step1_count}→필터${fc}→네이버${nc}→이미지${ic}개`, \"success\");\n\n        // ── generate-title: 키워드 기반 최적화 상품명 생성 → D열 ──\n        if (g.keywords.length > 0) {\n          try {\n            const titleRes = await fetch(API_URL, {\n              method: \"POST\", headers: { \"Content-Type\": \"application/json\" },\n              body: JSON.stringify({ action: \"generate-title\", productName: g.name, keywords: g.keywords, categoryName: g.categoryName }),\n            });\n            if (titleRes.ok) {\n              const titleData = await titleRes.json();\n              g.title = titleData.title || \"\";\n              log(`상품명 생성: \"${g.title}\" (${titleData.length}자, 커버리지 ${titleData.coverage})`, \"success\");\n            } else {\n              log(`상품명 생성 실패 (${titleRes.status}) — 키워드만 사용`, \"error\");\n            }\n          } catch (titleErr) {\n            log(`상품명 생성 오류: ${titleErr.message} — 키워드만 사용`, \"error\");\n          }\n        }\n\n        el.querySelector(\".status-icon\").textContent = \"✅\";\n        return;\n      } catch (err) {\n        log(`실패 (${attempt+1}/${MAX_RETRIES+1}): ${g.name} — ${err.message}`, \"error\");\n      }\n    }\n    el.querySelector(\".status-icon\").textContent = \"🔴\";\n    kwEl.textContent = \"오류\";\n    g.keywords = [];\n    failedItems.push(g.name);\n  }\n\n  // 병렬 배치 처리: CONCURRENCY개씩 동시 실행\n  for (let i = 0; i < productGroups.length; i += CONCURRENCY) {\n    const batch = productGroups.slice(i, i + CONCURRENCY);\n    const promises = batch.map((g, j) => processWithRetry(g, i + j));\n    await Promise.all(promises);\n    completed += batch.length;\n    const pct = Math.round(completed / productGroups.length * 100);\n    progressBar.style.width = `${pct}%`;\n    document.getElementById(\"progressLabel\").textContent = `처리 중… ${completed} / ${productGroups.length} 상품`;\n    document.getElementById(\"progressPct\").textContent = `${pct}%`;\n    const totalKws = productGroups.reduce((sum, g) => sum + (g.keywords ? g.keywords.length : 0), 0);\n    document.getElementById(\"progressSub\").textContent = `키워드 ${totalKws.toLocaleString()}개 추출됨`;\n    log(`진행: ${completed}/${productGroups.length} (${pct}%)`, \"info\");\n    if (i + CONCURRENCY < productGroups.length) await delay(1000);\n  }\n  const failMsg = failedItems.length > 0 ? ` (실패 ${failedItems.length}건)` : \"\";\n  btnStart.textContent = \"처리 완료\" + failMsg; btnDownload.classList.add(\"show\");\n  log(`전체 처리 완료${failMsg}. 다운로드 버튼을 클릭하세요.`, \"success\");\n});\n\nbtnDownload.addEventListener(\"click\", () => {\n  const colL = 11, colD = 3;\n  for (const g of productGroups) {\n    if (!g.keywords || !g.keywords.length) continue;\n    // D열: 최적화된 상품명 쓰기\n    if (g.title) {\n      for (const r of g.rows) sheetData[r][colD] = g.title;\n    }\n    const kws = g.keywords, rowCount = g.rows.length;\n    if (rowCount === 1) {\n      sheetData[g.rows[0]][colL] = kws.map(k => k.keyword).join(\",\");\n    } else {\n      const pairs = []; let left = 0, right = kws.length - 1;\n      while (left <= right) {\n        if (left === right) pairs.push(kws[left].keyword);\n        else pairs.push(kws[left].keyword + \",\" + kws[right].keyword);\n        left++; right--;\n      }\n      for (let r = 0; r < rowCount; r++) sheetData[g.rows[r]][colL] = pairs[r % pairs.length];\n    }\n  }\n  const newSheet = XLSX.utils.aoa_to_sheet(sheetData);\n  const newWb = XLSX.utils.book_new();\n  XLSX.utils.book_append_sheet(newWb, newSheet, workbook.SheetNames[0]);\n  XLSX.writeFile(newWb, \"키워드최적화_결과.xlsx\");\n  const titleCount = productGroups.filter(g => g.title).length;\n  log(`다운로드 완료 — D열 상품명 ${titleCount}건 + L열 키워드 고트래픽↔롱테일 페어링 분배`, \"success\");\n});\n\nfunction log(msg, type = \"info\") {\n  const line = document.createElement(\"div\"); line.className = type;\n  line.textContent = `[${new Date().toLocaleTimeString(\"ko-KR\")}] ${msg}`;\n  logEl.appendChild(line); logEl.scrollTop = logEl.scrollHeight;\n}\n</script>\n</body>\n</html>";\n\n// ========================\n// HELPERS\n// ========================\nfunction gradeClass(g) {\n  if (g === \"S\") return \"kqs-s\";\n  if (g === \"A\") return \"kqs-a\";\n  if (g === \"B\") return \"kqs-b\";\n  if (g === \"C\") return \"kqs-c\";\n  return \"kqs-d\";\n}\nfunction compLabel(c) {\n  if (c === \"\ub0ae\uc74c\") return \"\ub0ae\uc74c\";\n  if (c === \"\ub192\uc74c\") return \"\ub192\uc74c\";\n  return \"\ubcf4\ud1b5\";\n}\nfunction compColor(c) {\n  if (c === \"\ub0ae\uc74c\") return \"var(--green)\";\n  if (c === \"\ub192\uc74c\") return \"var(--red)\";\n  return \"var(--orange)\";\n}\nfunction stratText(grade) {\n  if (grade === \"S\") return \"\uba54\uc778 \ud0a4\uc6cc\ub4dc\";\n  if (grade === \"A\") return \"\uc11c\ube0c \ud0a4\uc6cc\ub4dc\";\n  if (grade === \"B\") return \"\uce74\ud14c\uace0\ub9ac \ud655\uc7a5\";\n  if (grade === \"C\") return \"\ub871\ud14c\uc77c\";\n  return \"\ubaa8\ub2c8\ud130\ub9c1\";\n}\n\n// ========================\n// TAB SWITCHING\n// ========================\ndocument.querySelectorAll(\"#mainTabs .tab\").forEach(tab => {\n  tab.addEventListener(\"click\", function() {\n    document.querySelectorAll(\"#mainTabs .tab\").forEach(t => t.classList.remove(\"on\"));\n    this.classList.add(\"on\");\n    const target = this.dataset.tab;\n    document.getElementById(\"tool-single\").style.display = target === \"single\" ? \"block\" : \"none\";\n    document.getElementById(\"tool-bulk\").style.display = target === \"bulk\" ? \"block\" : \"none\";\n  });\n});\n\n// ========================\n// MODE SWITCHING\n// ========================\ndocument.querySelectorAll(\".mode-label\").forEach(label => {\n  label.addEventListener(\"click\", function() {\n    document.querySelectorAll(\".mode-label\").forEach(l => l.classList.remove(\"selected\"));\n    this.classList.add(\"selected\");\n    this.querySelector(\"input[type=radio]\").checked = true;\n  });\n});\n\n// ========================\n// TAB 1: SINGLE KEYWORD\n// ========================\nconst singleInput = document.getElementById(\"singleKeyword\");\nconst btnSearch = document.getElementById(\"btnSearch\");\nconst singleStatus = document.getElementById(\"singleStatus\");\nconst singleSummary = document.getElementById(\"singleSummary\");\nconst kwTableWrap = document.getElementById(\"kwTableWrap\");\nconst kwTableBody = document.getElementById(\"kwTableBody\");\nconst btnCopyKw = document.getElementById(\"btnCopyKw\");\nconst singleFooterText = document.getElementById(\"singleFooterText\");\n\nlet singleKeywords = [];\n\nsingleInput.addEventListener(\"keydown\", (e) => { if (e.key === \"Enter\") btnSearch.click(); });\n\nbtnSearch.addEventListener(\"click\", async () => {\n  const keyword = singleInput.value.trim();\n  if (!keyword) { singleInput.focus(); return; }\n\n  btnSearch.disabled = true;\n  btnSearch.textContent = \"\ubd84\uc11d \uc911...\";\n  singleStatus.classList.add(\"show\");\n  singleSummary.classList.remove(\"show\");\n  kwTableWrap.classList.remove(\"show\");\n  btnCopyKw.style.display = \"none\";\n  singleFooterText.style.display = \"none\";\n  logEl.classList.add(\"show\");\n  log(`\ub2e8\uc77c \ud0a4\uc6cc\ub4dc \ubd84\uc11d \uc2dc\uc791: \"${keyword}\"`, \"info\");\n\n  try {\n    const res = await fetch(API_URL, {\n      method: \"POST\",\n      headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify({ productName: keyword, mode: \"single\" }),\n    });\n    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);\n    const data = await res.json();\n    singleKeywords = data.keywords || [];\n\n    // Summary\n    document.getElementById(\"singleTotal\").textContent = singleKeywords.length;\n    const topVol = singleKeywords.length > 0 ? singleKeywords[0].volume.toLocaleString() : \"0\";\n    document.getElementById(\"singleTopVol\").textContent = topVol;\n    const saCount = singleKeywords.filter(k => k.kqs_grade === \"S\" || k.kqs_grade === \"A\").length;\n    document.getElementById(\"singleSGrade\").textContent = saCount;\n    document.getElementById(\"pipelineText\").innerHTML =\n      `<strong>Step 1</strong> AI \uc0dd\uc131 ${data.step1_count}\uac1c \u2192 <strong>\ud544\ud130</strong> ${data.filter_count}\uac1c \u2192 <strong>\ucd5c\uc885</strong> ${singleKeywords.length}\uac1c KQS \ub4f1\uae09 \uc0b0\ucd9c`;\n\n    // Grade summary\n    const grades = { S: 0, A: 0, B: 0, C: 0, D: 0 };\n    singleKeywords.forEach(k => { if (grades[k.kqs_grade] !== undefined) grades[k.kqs_grade]++; });\n    document.getElementById(\"gradeSummary\").innerHTML = Object.entries(grades)\n      .filter(([, v]) => v > 0)\n      .map(([g, v]) => `<span class=\"gs-item\"><span class=\"kqs ${gradeClass(g)}\">${g}</span><strong>${v}</strong></span>`)\n      .join(\"\");\n    singleSummary.classList.add(\"show\");\n\n    // Table (\ubaa9\uc5c5 \uc2a4\ud0c0\uc77c \uadf8\ub300\ub85c)\n    kwTableBody.innerHTML = singleKeywords.map((kw, i) => {\n      const ctrPct = (kw.avg_ctr * 100).toFixed(1);\n      return `<tr>\n        <td style=\"text-align:center\">${i + 1}</td>\n        <td style=\"text-align:center\"><span class=\"kqs ${gradeClass(kw.kqs_grade)}\">${kw.kqs_grade}</span></td>\n        <td style=\"font-weight:600\">${kw.keyword}</td>\n        <td style=\"text-align:right\">${kw.volume.toLocaleString()}</td>\n        <td style=\"text-align:right;color:${compColor(kw.comp_idx)}\">${compLabel(kw.comp_idx)}</td>\n        <td style=\"text-align:right\">${ctrPct}%</td>\n        <td style=\"font-size:12px;color:var(--gray-500)\">${stratText(kw.kqs_grade)}</td>\n      </tr>`;\n    }).join(\"\");\n    kwTableWrap.classList.add(\"show\");\n    btnCopyKw.style.display = \"inline-flex\";\n\n    // Footer text\n    singleFooterText.textContent = `\ucd1d ${singleKeywords.length}\uac1c \ud0a4\uc6cc\ub4dc \u00b7 S\ub4f1\uae09 ${grades.S} \u00b7 A\ub4f1\uae09 ${grades.A}`;\n    singleFooterText.style.display = \"inline\";\n\n    log(`\uc644\ub8cc: AI ${data.step1_count}\uac1c \u2192 \ud544\ud130 ${data.filter_count}\uac1c \u2192 KQS ${singleKeywords.length}\uac1c (S:${grades.S} A:${grades.A} B:${grades.B} C:${grades.C} D:${grades.D})`, \"success\");\n  } catch (err) {\n    log(`\uc624\ub958: ${err.message}`, \"error\");\n  } finally {\n    singleStatus.classList.remove(\"show\");\n    btnSearch.disabled = false;\n    btnSearch.textContent = \"\ubd84\uc11d\";\n  }\n});\n\nbtnCopyKw.addEventListener(\"click\", () => {\n  if (!singleKeywords.length) return;\n  const text = singleKeywords.map(k => k.keyword).join(\", \");\n  navigator.clipboard.writeText(text).then(() => {\n    btnCopyKw.textContent = \"\u2705 \ubcf5\uc0ac\ub428!\";\n    setTimeout(() => { btnCopyKw.textContent = \"\ud83d\udccb \ud0a4\uc6cc\ub4dc \uc804\uccb4 \ubcf5\uc0ac\"; }, 2000);\n  }).catch(() => {\n    const ta = document.createElement(\"textarea\");\n    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand(\"copy\"); document.body.removeChild(ta);\n    btnCopyKw.textContent = \"\u2705 \ubcf5\uc0ac\ub428!\";\n    setTimeout(() => { btnCopyKw.textContent = \"\ud83d\udccb \ud0a4\uc6cc\ub4dc \uc804\uccb4 \ubcf5\uc0ac\"; }, 2000);\n  });\n});\n\n// ========================\n// TAB 2: EXCEL BULK\n// ========================\nlet workbook = null, sheetData = [], productGroups = [];\n\nconst dropzone = document.getElementById(\"dropzone\");\nconst fileInput = document.getElementById(\"fileInput\");\nconst fileInfo = document.getElementById(\"fileInfo\");\nconst btnStart = document.getElementById(\"btnStart\");\nconst progressSection = document.getElementById(\"progressSection\");\nconst productList = document.getElementById(\"productList\");\nconst progressBar = document.getElementById(\"progressBar\");\nconst btnDownload = document.getElementById(\"btnDownload\");\nconst logEl = document.getElementById(\"log\");\n\ndropzone.addEventListener(\"click\", () => fileInput.click());\ndropzone.addEventListener(\"dragover\", (e) => { e.preventDefault(); dropzone.classList.add(\"dragover\"); });\ndropzone.addEventListener(\"dragleave\", () => dropzone.classList.remove(\"dragover\"));\ndropzone.addEventListener(\"drop\", (e) => {\n  e.preventDefault(); dropzone.classList.remove(\"dragover\");\n  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);\n});\nfileInput.addEventListener(\"change\", (e) => { if (e.target.files.length) handleFile(e.target.files[0]); });\n\nfunction handleFile(file) {\n  log(`\ud30c\uc77c \ub85c\ub4dc: ${file.name}`, \"info\");\n  logEl.classList.add(\"show\");\n  const reader = new FileReader();\n  reader.onload = async (e) => {\n    workbook = XLSX.read(e.target.result, { type: \"array\" });\n    const sheet = workbook.Sheets[workbook.SheetNames[0]];\n    sheetData = XLSX.utils.sheet_to_json(sheet, { header: 1 });\n    const colD = 3, colE = 4, colB = 1, colM = 12, colT = 19;\n    const groups = {};\n    for (let i = 1; i < sheetData.length; i++) {\n      const row = sheetData[i];\n      const code = row[colB] || `row_${i}`;\n      if (!groups[code]) groups[code] = { code, name: row[colE] || row[colD] || \"\", imageUrl: row[colM] || \"\", categoryName: row[colT] || \"\", rows: [], keywords: null };\n      groups[code].rows.push(i);\n    }\n    productGroups = Object.values(groups);\n    document.getElementById(\"fileName\").textContent = `\ud83d\udcc4 ${file.name}`;\n    document.getElementById(\"totalRows\").textContent = (sheetData.length - 1).toLocaleString();\n    document.getElementById(\"uniqueProducts\").textContent = productGroups.length.toLocaleString();\n    document.getElementById(\"estTime\").textContent = `~${Math.ceil(productGroups.length / 5 * 13)}\ucd08`;\n    fileInfo.classList.add(\"show\");\n    document.getElementById(\"modeBar\").style.display = \"flex\";\n    document.getElementById(\"modeInfo\").style.display = \"flex\";\n    btnStart.classList.add(\"show\");\n    log(`${productGroups.length}\uac1c \uace0\uc720 \uc0c1\ud488 \uac10\uc9c0`, \"success\");\n\n    // \u2500\u2500 \ub9c8\uc774\uce74\ud14c \ucf54\ub4dc \u2192 \uce74\ud14c\uace0\ub9ac\uba85 \ubcc0\ud658 (jj2_category \ud14c\uc774\ube14) \u2500\u2500\n    const catCodes = [...new Set(productGroups.map(g => g.categoryName).filter(c => c && /^[A-Z]?\\d+/.test(c)))];\n    if (catCodes.length > 0) {\n      log(`\ub9c8\uc774\uce74\ud14c \uc870\ud68c \uc911...`, \"info\");\n      try {\n        const SB_URL = \"https://uifjabklkmvfbsplvxsu.supabase.co\";\n        const SB_KEY = \"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpZmphYmtsa212ZmJzcGx2eHN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxNDMwOTEsImV4cCI6MjA4OTcxOTA5MX0.1_rWJ0RDk_KXw86ewRq-F9DKIj6D7oaCzRWlrImzu2M\";\n        const codeFilter = catCodes.map(c => `\"${c}\"`).join(\",\");\n        const catRes = await fetch(`${SB_URL}/rest/v1/jj2_category?category_code=in.(${codeFilter})&select=category_code,category_name`, {\n          headers: { \"apikey\": SB_KEY, \"Authorization\": `Bearer ${SB_KEY}` }\n        });\n        if (catRes.ok) {\n          const catData = await catRes.json();\n          const catMap = {};\n          for (const row of catData) catMap[row.category_code] = row.category_name;\n          let mapped = 0;\n          for (const g of productGroups) {\n            if (g.categoryName && catMap[g.categoryName]) {\n              g.categoryName = catMap[g.categoryName];\n              mapped++;\n            }\n          }\n          log(`\uce74\ud14c\uace0\ub9ac \uc870\ud68c \uc644\ub8cc \u2014 ${mapped}\uac1c \ucf54\ub4dc \ub9e4\ud551`, \"success\");\n        }\n      } catch (e) { log(`\uce74\ud14c\uace0\ub9ac \uc870\ud68c \uc2e4\ud328 (\ubb34\uc2dc): ${e.message}`, \"error\"); }\n    }\n  };\n  reader.readAsArrayBuffer(file);\n}\n\nbtnStart.addEventListener(\"click\", async () => {\n  btnStart.disabled = true; btnStart.textContent = \"\ucc98\ub9ac \uc911...\";\n  progressSection.classList.add(\"show\"); logEl.classList.add(\"show\");\n\n  productList.innerHTML = productGroups.map((g, i) => `\n    <li class=\"product-item\" id=\"prod-${i}\">\n      <span class=\"status-icon\">\u2b1c</span><span class=\"name\">${g.name}</span>\n      <span class=\"kw-count\" id=\"kwcount-${i}\"></span>\n    </li>`).join(\"\");\n\n  const delay = (ms) => new Promise(r => setTimeout(r, ms));\n  const MAX_RETRIES = 2;\n  const RETRY_DELAY = 8000;\n  const CONCURRENCY = 5;\n\n  const excelMode = document.querySelector('input[name=\"excelMode\"]:checked')?.value || \"normal\";\n  log(`\ubaa8\ub4dc: ${excelMode === \"fast\" ? \"\ube60\ub978 \ubaa8\ub4dc\" : \"\uc815\ubc00 \ubaa8\ub4dc\"}`, \"info\");\n\n  async function processOne(g) {\n    const payload = excelMode === \"fast\"\n      ? { action: \"excel-fast\", productName: g.name, categoryName: g.categoryName }\n      : { productName: g.name, imageUrl: g.imageUrl, categoryName: g.categoryName };\n    const res = await fetch(API_URL, {\n      method: \"POST\", headers: { \"Content-Type\": \"application/json\" },\n      body: JSON.stringify(payload),\n    });\n    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);\n    return await res.json();\n  }\n\n  let completed = 0;\n  const failedItems = [];\n\n  async function processWithRetry(g, idx) {\n    const el = document.getElementById(`prod-${idx}`);\n    const kwEl = document.getElementById(`kwcount-${idx}`);\n    el.querySelector(\".status-icon\").innerHTML = '<span class=\"spinner\"></span>';\n\n    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {\n      if (attempt > 0) {\n        kwEl.textContent = `\uc7ac\uc2dc\ub3c4 ${attempt}/${MAX_RETRIES}`;\n        await delay(RETRY_DELAY);\n        el.querySelector(\".status-icon\").innerHTML = '<span class=\"spinner\"></span>';\n      }\n      try {\n        const data = await processOne(g);\n        g.keywords = data.keywords || [];\n        const fc = data.filter_count !== undefined ? data.filter_count : \"?\";\n        const nc = data.naver_count !== undefined ? data.naver_count : \"?\";\n        const ic = data.image_count !== undefined ? data.image_count : g.keywords.length;\n        kwEl.textContent = `${data.step1_count}\u2192${fc}\u2192${nc}\u2192${ic}\uac1c`;\n        log(`\ud0a4\uc6cc\ub4dc \uc644\ub8cc: ${g.name} \u2014 AI ${data.step1_count}\u2192\ud544\ud130${fc}\u2192\ub124\uc774\ubc84${nc}\u2192\uc774\ubbf8\uc9c0${ic}\uac1c`, \"success\");\n\n        // \u2500\u2500 generate-title: \ud0a4\uc6cc\ub4dc \uae30\ubc18 \ucd5c\uc801\ud654 \uc0c1\ud488\uba85 \uc0dd\uc131 \u2192 D\uc5f4 \u2500\u2500\n        if (g.keywords.length > 0) {\n          try {\n            const titleRes = await fetch(API_URL, {\n              method: \"POST\", headers: { \"Content-Type\": \"application/json\" },\n              body: JSON.stringify({ action: \"generate-title\", productName: g.name, keywords: g.keywords, categoryName: g.categoryName }),\n            });\n            if (titleRes.ok) {\n              const titleData = await titleRes.json();\n              g.title = titleData.title || \"\";\n              log(`\uc0c1\ud488\uba85 \uc0dd\uc131: \"${g.title}\" (${titleData.length}\uc790, \ucee4\ubc84\ub9ac\uc9c0 ${titleData.coverage})`, \"success\");\n            } else {\n              log(`\uc0c1\ud488\uba85 \uc0dd\uc131 \uc2e4\ud328 (${titleRes.status}) \u2014 \ud0a4\uc6cc\ub4dc\ub9cc \uc0ac\uc6a9`, \"error\");\n            }\n          } catch (titleErr) {\n            log(`\uc0c1\ud488\uba85 \uc0dd\uc131 \uc624\ub958: ${titleErr.message} \u2014 \ud0a4\uc6cc\ub4dc\ub9cc \uc0ac\uc6a9`, \"error\");\n          }\n        }\n\n        el.querySelector(\".status-icon\").textContent = \"\u2705\";\n        return;\n      } catch (err) {\n        log(`\uc2e4\ud328 (${attempt+1}/${MAX_RETRIES+1}): ${g.name} \u2014 ${err.message}`, \"error\");\n      }\n    }\n    el.querySelector(\".status-icon\").textContent = \"\ud83d\udd34\";\n    kwEl.textContent = \"\uc624\ub958\";\n    g.keywords = [];\n    failedItems.push(g.name);\n  }\n\n  // \ubcd1\ub82c \ubc30\uce58 \ucc98\ub9ac: CONCURRENCY\uac1c\uc529 \ub3d9\uc2dc \uc2e4\ud589\n  for (let i = 0; i < productGroups.length; i += CONCURRENCY) {\n    const batch = productGroups.slice(i, i + CONCURRENCY);\n    const promises = batch.map((g, j) => processWithRetry(g, i + j));\n    await Promise.all(promises);\n    completed += batch.length;\n    const pct = Math.round(completed / productGroups.length * 100);\n    progressBar.style.width = `${pct}%`;\n    document.getElementById(\"progressLabel\").textContent = `\ucc98\ub9ac \uc911\u2026 ${completed} / ${productGroups.length} \uc0c1\ud488`;\n    document.getElementById(\"progressPct\").textContent = `${pct}%`;\n    const totalKws = productGroups.reduce((sum, g) => sum + (g.keywords ? g.keywords.length : 0), 0);\n    document.getElementById(\"progressSub\").textContent = `\ud0a4\uc6cc\ub4dc ${totalKws.toLocaleString()}\uac1c \ucd94\ucd9c\ub428`;\n    log(`\uc9c4\ud589: ${completed}/${productGroups.length} (${pct}%)`, \"info\");\n    if (i + CONCURRENCY < productGroups.length) await delay(1000);\n  }\n  const failMsg = failedItems.length > 0 ? ` (\uc2e4\ud328 ${failedItems.length}\uac74)` : \"\";\n  btnStart.textContent = \"\ucc98\ub9ac \uc644\ub8cc\" + failMsg; btnDownload.classList.add(\"show\");\n  log(`\uc804\uccb4 \ucc98\ub9ac \uc644\ub8cc${failMsg}. \ub2e4\uc6b4\ub85c\ub4dc \ubc84\ud2bc\uc744 \ud074\ub9ad\ud558\uc138\uc694.`, \"success\");\n});\n\nbtnDownload.addEventListener(\"click\", () => {\n  const colL = 11, colD = 3;\n  for (const g of productGroups) {\n    if (!g.keywords || !g.keywords.length) continue;\n    // D\uc5f4: \ucd5c\uc801\ud654\ub41c \uc0c1\ud488\uba85 \uc4f0\uae30\n    if (g.title) {\n      for (const r of g.rows) sheetData[r][colD] = g.title;\n    }\n    const kws = g.keywords, rowCount = g.rows.length;\n    if (rowCount === 1) {\n      sheetData[g.rows[0]][colL] = kws.map(k => k.keyword).join(\",\");\n    } else {\n      const pairs = []; let left = 0, right = kws.length - 1;\n      while (left <= right) {\n        if (left === right) pairs.push(kws[left].keyword);\n        else pairs.push(kws[left].keyword + \",\" + kws[right].keyword);\n        left++; right--;\n      }\n      for (let r = 0; r < rowCount; r++) sheetData[g.rows[r]][colL] = pairs[r % pairs.length];\n    }\n  }\n  const newSheet = XLSX.utils.aoa_to_sheet(sheetData);\n  const newWb = XLSX.utils.book_new();\n  XLSX.utils.book_append_sheet(newWb, newSheet, workbook.SheetNames[0]);\n  XLSX.writeFile(newWb, \"\ud0a4\uc6cc\ub4dc\ucd5c\uc801\ud654_\uacb0\uacfc.xlsx\");\n  const titleCount = productGroups.filter(g => g.title).length;\n  log(`\ub2e4\uc6b4\ub85c\ub4dc \uc644\ub8cc \u2014 D\uc5f4 \uc0c1\ud488\uba85 ${titleCount}\uac74 + L\uc5f4 \ud0a4\uc6cc\ub4dc \uace0\ud2b8\ub798\ud53d\u2194\ub871\ud14c\uc77c \ud398\uc5b4\ub9c1 \ubd84\ubc30`, \"success\");\n});\n\nfunction log(msg, type = \"info\") {\n  const line = document.createElement(\"div\"); line.className = type;\n  line.textContent = `[${new Date().toLocaleTimeString(\"ko-KR\")}] ${msg}`;\n  logEl.appendChild(line); logEl.scrollTop = logEl.scrollHeight;\n}\n</script>\n</body>\n</html>";

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  // GET → HTML UI 서빙 (Edge Function은 정적 파일 미포함이므로 인라인 서빙)
  if (req.method === "GET") {
    return new Response(HTML_UI, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });
  }

  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const ip = req.headers.get("x-forwarded-for") || "anon";
    if (!checkRateLimit(ip)) return new Response(JSON.stringify({ error: "요청이 너무 빠릅니다. 1분 후 다시 시도해주세요.", code: "RATE_LIMIT" }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });

    const body = await req.json();

    // ── v52: /generate-title 엔드포인트 분기 ──
    if (body.action === "generate-title") {
      return await handleGenerateTitle(body, cors);
    }

    // ── excel-fast: Gemini 1회 통합, 이미지필터 제거, 속도 최적화 ──
    if (body.action === "excel-fast") {
      return await handleExcelFast(body, cors);
    }

    // ── v54: seed-expand — keyword_cache 시드를 네이버 API에 재투입해 키워드 폭발적 확장 (관리자용) ──
    if (body.action === "seed-expand") {
      return await handleSeedExpand(body, cors);
    }

    // ── v54: refresh-stale — 30일+ 묵은 키워드 재호출하여 검색량 갱신 (관리자용, 월간 배치) ──
    if (body.action === "refresh-stale") {
      return await handleRefreshStale(body, cors);
    }

    const { productName, imageUrl, mode, categoryName } = body;
    const v = validateProductName(productName);
    if (!v.valid) return new Response(JSON.stringify({ error: v.error, code: "INVALID_INPUT" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });

    const pn = productName.trim();
    const catName = (typeof categoryName === "string") ? categoryName.trim() : "";
    console.log(`[v52] ${mode||"excel"}: "${pn}" | img=${imageUrl||"none"} | cat="${catName}"`);

    // ── Step A1 + A2 + 이미지 선행 fetch (병렬 실행) ──
    const { tokens: coreTokens } = extractCoreKeywords(pn);
    const [A1, a2Result, prefetchedImageDesc] = await Promise.all([
      step1_expandKeywords(pn, coreTokens, catName),
      step1b_extractModifiers(pn, coreTokens, catName),
      (imageUrl && mode !== "single") ? step2a_describeImage(imageUrl) : Promise.resolve(null),
    ]);
    if (A1.length === 0) return new Response(JSON.stringify({ error: "AI 키워드 생성 실패. 잠시 후 다시 시도해주세요.", code: "GEMINI_FAILED" }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
    console.log(`[step-A1] Gemini keywords: ${A1.length}`);
    console.log(`[step-A2] coreWords=${a2Result.coreWords.join(",")}, synonyms=${a2Result.synonyms.join(",")}, modifiers=${a2Result.modifiers.length}, compounds=${a2Result.compounds.length}, category=${a2Result.category}`);
    if (prefetchedImageDesc) console.log(`[prefetch-img] "${prefetchedImageDesc}"`);

    // ── A1 + A2 병합 (Gemini 키워드만, 네이버 확장 없음) ──
    const allKeywords = [...new Set([...A1, ...a2Result.compounds, ...a2Result.synonyms])];
    console.log(`[merge] A1=${A1.length} + A2=${a2Result.compounds.length} + synonyms=${a2Result.synonyms.length} = ${allKeywords.length} unique`);

    // ── Step B: 기본 필터 (2자 이하 제거만, 금칙어/브랜드는 KIPRIS에서 처리) ──
    let shortCount = 0;
    const filtered = allKeywords.filter(k => {
      if (k.replace(/\s/g, "").length <= 2) { shortCount++; return false; }
      return true;
    });
    console.log(`[filter] ${allKeywords.length} → ${filtered.length} (short=${shortCount})`);

    // ── Step C: 네이버 검색량 조회 (확장 아님, 볼륨만 체크) ──
    const effectiveCategory = catName || a2Result.category;
    const volumeResults = await step3_checkVolume(filtered, effectiveCategory);
    console.log(`[volume] filtered=${filtered.length} → volume_passed=${volumeResults.length}`);

    if (mode === "single") {
      logSearch(volumeResults.map(v => v.keyword), "single", pn).catch(() => {});
      return new Response(JSON.stringify({ productName: pn, step1_count: A1.length, step1b_count: a2Result.compounds.length, merged_count: allKeywords.length, filter_count: filtered.length, naver_count: volumeResults.length, keywords: volumeResults, _debug: { a2_coreWords: a2Result.coreWords, a2_synonyms: a2Result.synonyms, a2_modifiers_count: a2Result.modifiers.length, a2_modifiers_sample: a2Result.modifiers.slice(0, 15), category: effectiveCategory } }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ── Step D: 이미지 필터 (엑셀 모드만, 선행 fetch 결과 재사용) ──
    const imgResult = await step2_filterByImage(volumeResults.map(v => v.keyword), imageUrl, pn, prefetchedImageDesc);
    const afterImage = volumeResults.filter(v => imgResult.keywords.includes(v.keyword));
    console.log(`[image] volume=${volumeResults.length} → image_passed=${afterImage.length}`);

    // ── Step E: 카테고리 관련성 필터 (v52 신규, catName 있을 때만) ──
    const catResult = await stepCategoryFilter(afterImage.map(v => v.keyword), catName);
    const catPassedSet = new Set(catResult.passed);
    const final = afterImage.filter(v => catPassedSet.has(v.keyword));
    console.log(`[cat-filter] image=${afterImage.length} → cat_passed=${final.length}`);

    logSearch(final.map(v => v.keyword), "excel", pn).catch(() => {});
    const legacy = final.map(v => ({ keyword: v.keyword, volume: v.volume }));
    return new Response(JSON.stringify({ productName: pn, step1_count: A1.length, step1b_count: a2Result.compounds.length, merged_count: allKeywords.length, filter_count: filtered.length, naver_count: volumeResults.length, image_count: afterImage.length, category_count: final.length, keywords: legacy, keywordsV2: final, _debug: { a2_coreWords: a2Result.coreWords, a2_synonyms: a2Result.synonyms, a2_modifiers_count: a2Result.modifiers.length, a2_modifiers_sample: a2Result.modifiers.slice(0, 15), category: effectiveCategory, categoryName: catName, imageDesc: imgResult.imageDesc, imageSkipped: imgResult.skipped, scores: imgResult.scores, catRemoved: catResult.removed.slice(0, 20) } }), { headers: { ...cors, "Content-Type": "application/json" } });

  } catch (e) {
    console.error("Handler error:", e);
    return new Response(JSON.stringify({ error: "서버 오류가 발생했습니다.", code: "INTERNAL_ERROR" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
