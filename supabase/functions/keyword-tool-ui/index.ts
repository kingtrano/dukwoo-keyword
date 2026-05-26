import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const STORAGE_URL = "https://uifjabklkmvfbsplvxsu.supabase.co/storage/v1/object/public/web/keyword-tool.html";

Deno.serve(async (_req: Request) => {
  try {
    const res = await fetch(STORAGE_URL);
    const html = await res.text();
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    return new Response("Error loading page", { status: 500 });
  }
});
