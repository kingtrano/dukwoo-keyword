import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GEMINI_KEY = Deno.env.get("GEMINI_KEY") || "AIzaSyBEghSACdDkvF5Tj9cxVH2iCjsGfazrslU";
const NAVER_CUSTOMER_ID = Deno.env.get("NAVER_CUSTOMER_ID") || "3062209";
const NAVER_API_KEY = Deno.env.get("NAVER_API_KEY") || "0100000000f8d969b084ed12e9e2b3c91d00f5594720a34698db84b9cab29ca3ba17df1380";
const NAVER_SECRET_KEY = Deno.env.get("NAVER_SECRET_KEY") || "AQAAAAD42WmwhO0S6eKzyR0A9VlHZ3DPtDTEkt8TC64DmcIAxg==";

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

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
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
