// delete-account — 회원 탈퇴 처리
// 1) 사용자 인증 확인 (Authorization Bearer JWT)
// 2) 탈퇴 확인 메일 발송 (Resend API 직접 호출)
// 3) 사용자 데이터 삭제 (user_profiles 등 — RLS는 SERVICE_ROLE_KEY로 우회)
// 4) Supabase Auth admin API로 user 삭제
// 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://uifjabklkmvfbsplvxsu.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM_EMAIL = "noreply@keywordlab.ai";
const FROM_NAME = "keywordlab.ai";

if (!SERVICE_ROLE_KEY) console.error("[FATAL] SUPABASE_SERVICE_ROLE_KEY missing");
if (!RESEND_API_KEY) console.error("[WARN] RESEND_API_KEY missing — 메일 발송 skip");

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey",
};

function buildDeletionEmailHtml(email: string, deletedAtKst: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>keywordlab.ai 탈퇴 완료</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;padding:40px 16px">
<tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,.06)">
<tr><td style="background:linear-gradient(135deg,#334155 0%,#475569 100%);padding:36px 40px">
<div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-.3px">keywordlab<span style="color:#94A3B8">.ai</span></div>
<div style="font-size:12px;color:#CBD5E1;margin-top:4px">엑셀 벌크 키워드 SaaS</div>
</td></tr>
<tr><td style="padding:40px 40px 16px">
<div style="font-size:14px;color:#64748B;font-weight:700;margin-bottom:8px">👋 안녕히 가세요</div>
<h1 style="font-size:24px;font-weight:800;color:#0F172A;margin:0 0 16px;line-height:1.35">계정 탈퇴가 완료되었습니다</h1>
<p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 24px"><b style="color:#0F172A">${email}</b> 계정의 탈퇴 처리가 완료되었습니다.<br>그동안 keywordlab.ai를 이용해주셔서 진심으로 감사드립니다.</p>
<div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:20px;margin-bottom:24px">
<div style="font-size:13px;font-weight:700;color:#0F172A;margin-bottom:12px">📋 처리 내역</div>
<table cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td style="font-size:13px;color:#475569;padding:5px 0;border-bottom:1px solid #F1F5F9">탈퇴 완료일</td><td style="text-align:right;font-size:13px;color:#0F172A;font-weight:600;padding:5px 0;border-bottom:1px solid #F1F5F9">${deletedAtKst}</td></tr>
<tr><td style="font-size:13px;color:#475569;padding:5px 0;border-bottom:1px solid #F1F5F9">계정 데이터</td><td style="text-align:right;font-size:13px;color:#0F172A;font-weight:600;padding:5px 0;border-bottom:1px solid #F1F5F9">즉시 삭제</td></tr>
<tr><td style="font-size:13px;color:#475569;padding:5px 0;border-bottom:1px solid #F1F5F9">잔여 크레딧</td><td style="text-align:right;font-size:13px;color:#DC2626;font-weight:600;padding:5px 0;border-bottom:1px solid #F1F5F9">소멸 (환불 X)</td></tr>
<tr><td style="font-size:13px;color:#475569;padding:5px 0">처리 이력</td><td style="text-align:right;font-size:13px;color:#475569;padding:5px 0">법령 보관 후 파기</td></tr>
</table>
</div>
<div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;padding:18px 20px;margin-bottom:24px">
<div style="font-size:13px;font-weight:700;color:#1E40AF;margin-bottom:8px">💡 다시 시작하고 싶으시면</div>
<p style="font-size:13px;color:#1E3A8A;line-height:1.7;margin:0">같은 이메일로 언제든 재가입 가능합니다. 단, 이전 데이터(검색 이력·잔액)는 복구되지 않습니다.</p>
</div>
<p style="font-size:13px;color:#475569;line-height:1.7;margin:0 0 16px">떠나신 이유가 궁금합니다. 한 줄 피드백을 남겨주시면 더 나은 서비스를 만드는 데 큰 도움이 됩니다.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px">
<tr><td style="border-radius:10px;background:#fff;border:1.5px solid #2563EB">
<a href="mailto:lhs@brightenllc.com?subject=keywordlab.ai 탈퇴 피드백" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#2563EB;text-decoration:none;border-radius:10px">피드백 보내기 →</a>
</td></tr>
</table>
<p style="font-size:12px;color:#94A3B8;line-height:1.7;margin:0">본인이 탈퇴를 신청하지 않았다면 즉시 <a href="mailto:lhs@brightenllc.com" style="color:#2563EB;text-decoration:none">고객센터</a>로 알려주세요. 계정 복구 가능 여부를 확인해드립니다.</p>
</td></tr>
<tr><td style="background:#F8FAFC;padding:24px 40px;border-top:1px solid #E2E8F0">
<p style="font-size:12px;color:#64748B;line-height:1.7;margin:0 0 8px"><b style="color:#0F172A">keywordlab.ai</b> · 주식회사 덕우무역<br>서울특별시 구로구 경인로53길 15, 중앙유통단지 업무에이동 053호 · 대표 김자헌</p>
<p style="font-size:11px;color:#94A3B8;line-height:1.6;margin:8px 0 0">통신판매업 2025-서울구로-1723호 · 문의 <a href="mailto:lhs@brightenllc.com" style="color:#2563EB;text-decoration:none">lhs@brightenllc.com</a></p>
<p style="font-size:10px;color:#CBD5E1;margin:12px 0 0">© 2026 keywordlab.ai. All rights reserved.</p>
</td></tr>
</table></td></tr>
</table>
</body></html>`;
}

async function sendDeletionEmail(toEmail: string, deletedAtKst: string): Promise<{ok: boolean; err?: string}> {
  if (!RESEND_API_KEY) return { ok: false, err: "RESEND_API_KEY missing" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [toEmail],
        subject: "👋 keywordlab.ai 탈퇴가 완료되었습니다",
        html: buildDeletionEmailHtml(toEmail, deletedAtKst),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, err: `Resend ${res.status}: ${text}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}

function kstNow(): string {
  const d = new Date();
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm} KST`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Authorization 헤더 없음" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "인증 실패: " + (userErr?.message || "사용자 없음") }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;
    const userEmail = userData.user.email || "";

    if (!userId || !userEmail) {
      return new Response(JSON.stringify({ error: "유효하지 않은 사용자" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const deletedAt = kstNow();

    const tables = [
      "user_transactions",
      "user_balance",
      "jobs",
      "library",
      "keyword_searches",
      "user_favorites",
      "user_groups",
      "feedback",
      "user_profiles",
    ];

    const tableErrors: Record<string, string> = {};
    for (const t of tables) {
      try {
        const { error } = await admin.from(t).delete().eq("user_id", userId);
        if (error && !String(error.message).toLowerCase().includes("does not exist")) {
          tableErrors[t] = error.message;
          console.error(`[delete ${t}]`, error.message);
        }
      } catch (e) {
        tableErrors[t] = String(e);
        console.error(`[delete ${t} exception]`, e);
      }
    }

    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) {
      return new Response(JSON.stringify({
        error: "계정 삭제 실패: " + delErr.message,
        tableErrors,
      }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const mailResult = await sendDeletionEmail(userEmail, deletedAt);

    return new Response(JSON.stringify({
      ok: true,
      deletedAt,
      mailSent: mailResult.ok,
      mailError: mailResult.ok ? undefined : mailResult.err,
      tableErrors: Object.keys(tableErrors).length ? tableErrors : undefined,
    }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[delete-account fatal]", e);
    return new Response(JSON.stringify({ error: "서버 오류: " + String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
