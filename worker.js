// ============================================================
// Tiger AI Team — المركز الرئيسي لفريق الموظفين الذكيين
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // --- الصفحة الرئيسية (اللوحة) ---
      if (path === "/" || path === "") {
        return new Response(DASHBOARD_HTML, {
          headers: { "content-type": "text/html; charset=UTF-8" },
        });
      }

      // --- إعداد قاعدة البيانات (يُشغّل مرة وحدة فقط) ---
      if (path === "/setup-db" && request.method === "GET") {
        await setupDatabase(env);
        return json({ ok: true, message: "تم إنشاء الجداول بنجاح" });
      }

      // --- حالة عامة لكل الموظفين (تستخدمها اللوحة) ---
      if (path === "/api/status") {
        return json(await getStatus(env));
      }

      // ===================== موظف الموقع =====================
      if (path === "/website/check" && request.method === "POST") {
        return json(await runWebsiteCheck(env));
      }
      if (path === "/website/reports") {
        return json(await getWebsiteReports(env));
      }

      // ===================== موظف بحث الشركات =====================
      if (path === "/leads/generate" && request.method === "POST") {
        const body = await request.json();
        return json(await generateLeads(env, body.sector, body.count || 8));
      }
      if (path === "/leads/list") {
        return json(await getLeads(env));
      }

      // ===================== موظف الإيميلات (Zoho) =====================
      if (path === "/zoho/connect") {
        return Response.redirect(buildZohoAuthUrl(env), 302);
      }
      if (path === "/zoho-callback") {
        return await handleZohoCallback(request, env);
      }
      if (path === "/email/inbox") {
        return json(await getEmailInboxSummary(env));
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500);
    }
  },

  // Cron: فحص الموقع يوميًا + أي مهام دورية لاحقًا
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWebsiteCheck(env));
  },
};

// ============================================================
// أدوات عامة
// ============================================================
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

async function setupDatabase(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS website_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT,
      status_code INTEGER,
      response_ms INTEGER,
      notes TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT,
      sector TEXT,
      company_name TEXT,
      email TEXT,
      website TEXT,
      draft_email TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT,
      from_addr TEXT,
      subject TEXT,
      summary TEXT,
      draft_reply TEXT
    )`),
  ]);
}

async function getStatus(env) {
  const website = await env.DB.prepare(
    "SELECT * FROM website_reports ORDER BY id DESC LIMIT 1"
  ).first();
  const leadsCount = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM leads"
  ).first();
  const emailCount = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM email_log"
  ).first();

  return {
    website: website || null,
    leads_total: leadsCount ? leadsCount.c : 0,
    emails_logged: emailCount ? emailCount.c : 0,
    zoho_connected: !!env.ZOHO_ACCESS_TOKEN,
  };
}

// ============================================================
// موظف الموقع — فحص دوري
// ============================================================
async function runWebsiteCheck(env) {
  const target = env.WEBSITE_URL || "https://example.com";
  const start = Date.now();
  let statusCode = 0;
  let notes = "";

  try {
    const res = await fetch(target, { redirect: "follow" });
    statusCode = res.status;
    const html = await res.text();
    const checks = [];
    if (!html.includes("<title>")) checks.push("لا يوجد وسم <title>");
    if (!html.match(/<meta[^>]+name=["']description["']/i))
      checks.push("لا يوجد meta description");
    if (!html.match(/<meta[^>]+name=["']viewport["']/i))
      checks.push("لا يوجد meta viewport (مهم للموبايل)");
    notes = checks.length ? checks.join(" | ") : "لا ملاحظات — الموقع سليم";
  } catch (e) {
    notes = "فشل الوصول للموقع: " + String(e);
  }

  const responseMs = Date.now() - start;

  await env.DB.prepare(
    `INSERT INTO website_reports (created_at, status_code, response_ms, notes) VALUES (?, ?, ?, ?)`
  )
    .bind(new Date().toISOString(), statusCode, responseMs, notes)
    .run();

  return { statusCode, responseMs, notes };
}

async function getWebsiteReports(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM website_reports ORDER BY id DESC LIMIT 20"
  ).all();
  return results;
}

// ============================================================
// موظف بحث الشركات — يولّد قائمة + مسودة إيميل عبر Claude (مع بحث ويب حقيقي)
// ============================================================
async function generateLeads(env, sector, count) {
  const prompt = `ابحث عن ${count} شركات أو مؤسسات حقيقية ومناسبة ضمن القطاع التالي: "${sector}"، يمكن تقديم خدمات تنظيم فعاليات (Tiger Event) لها.
لكل شركة أعطني: الاسم، الموقع الإلكتروني إن وجد، وإيميل تواصل عام إن وجد (من موقعها الرسمي فقط، ولا تخترع إيميلات).
ثم اكتب مسودة إيميل تعريفي قصير (3-4 أسطر) بالعربية الفصحى المهنية، يقدّم شركة Tiger Event لتنظيم الفعاليات، مخصص لكل شركة.
أعد النتيجة بصيغة JSON فقط بدون أي نص إضافي، بالشكل التالي:
[{"company_name":"...","website":"...","email":"...","draft_email":"..."}]`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  const data = await resp.json();
  const textBlocks = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  let list = [];
  try {
    const clean = textBlocks.replace(/```json|```/g, "").trim();
    list = JSON.parse(clean);
  } catch (e) {
    return { ok: false, error: "فشل تحليل الرد", raw: textBlocks };
  }

  for (const item of list) {
    await env.DB.prepare(
      `INSERT INTO leads (created_at, sector, company_name, email, website, draft_email) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        new Date().toISOString(),
        sector,
        item.company_name || "",
        item.email || "",
        item.website || "",
        item.draft_email || ""
      )
      .run();
  }

  return { ok: true, added: list.length, items: list };
}

async function getLeads(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM leads ORDER BY id DESC LIMIT 50"
  ).all();
  return results;
}

// ============================================================
// موظف الإيميلات — Zoho OAuth (هيكل جاهز، يفعّل بعد إضافة الأسرار)
// ============================================================
function buildZohoAuthUrl(env) {
  const params = new URLSearchParams({
    scope: "ZohoMail.messages.READ,ZohoMail.messages.CREATE",
    client_id: env.ZOHO_CLIENT_ID || "",
    response_type: "code",
    redirect_uri: env.ZOHO_REDIRECT_URI || "",
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.zoho.com/oauth/v2/auth?${params.toString()}`;
}

async function handleZohoCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return json({ ok: false, error: "لا يوجد code بالرابط" }, 400);

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    redirect_uri: env.ZOHO_REDIRECT_URI,
    code,
  });

  const resp = await fetch(
    `https://accounts.zoho.com/oauth/v2/token?${params.toString()}`,
    { method: "POST" }
  );
  const data = await resp.json();

  // ملاحظة: لازم تحفظ access_token/refresh_token يدويًا كـ Secret بعد أول ربط
  return json(data);
}

async function getEmailInboxSummary(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM email_log ORDER BY id DESC LIMIT 20"
  ).all();
  return results;
}

// ============================================================
// واجهة اللوحة (Dashboard HTML)
// ============================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tiger AI Team</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background:#0f1115; color:#eee; margin:0; padding:20px; }
  h1 { text-align:center; font-size:22px; margin-bottom:24px; }
  .grid { display:grid; grid-template-columns:1fr; gap:14px; max-width:480px; margin:0 auto; }
  .card { background:#1a1d24; border-radius:14px; padding:16px; border:1px solid #2a2e38; }
  .card h2 { font-size:16px; margin:0 0 8px; display:flex; align-items:center; gap:8px; }
  .card p { font-size:13px; color:#aaa; margin:4px 0; }
  .badge { font-size:11px; padding:2px 8px; border-radius:20px; background:#2a2e38; }
  .ok { color:#4ade80; } .bad { color:#f87171; }
  button { background:#3b82f6; color:#fff; border:none; padding:8px 12px; border-radius:8px; font-size:13px; margin-top:8px; }
</style>
</head>
<body>
<h1>🐯 Tiger AI Team — لوحة القيادة</h1>
<div class="grid" id="grid">جاري التحميل...</div>
<script>
async function load() {
  const res = await fetch('/api/status');
  const s = await res.json();
  const grid = document.getElementById('grid');
  grid.innerHTML = \`
    <div class="card">
      <h2>📧 موظف الإيميلات <span class="badge \${s.zoho_connected ? 'ok' : 'bad'}">\${s.zoho_connected ? 'متصل' : 'غير متصل'}</span></h2>
      <p>عدد الإيميلات المسجلة: \${s.emails_logged}</p>
      \${!s.zoho_connected ? '<button onclick="location.href=\\'/zoho/connect\\'">ربط Zoho</button>' : ''}
    </div>
    <div class="card">
      <h2>🌐 موظف الموقع</h2>
      <p>آخر فحص: \${s.website ? s.website.created_at : 'لم يُفحص بعد'}</p>
      <p>الحالة: \${s.website ? s.website.status_code : '-'} | ملاحظات: \${s.website ? s.website.notes : '-'}</p>
      <button onclick="fetch('/website/check',{method:'POST'}).then(load)">فحص الآن</button>
    </div>
    <div class="card">
      <h2>📷 موظف إنستقرام</h2>
      <p>مُدار عبر مشروع tiger-ig-token2 (منفصل حاليًا)</p>
    </div>
    <div class="card">
      <h2>🏢 موظف بحث الشركات</h2>
      <p>عدد الشركات المسجلة: \${s.leads_total}</p>
    </div>
  \`;
}
load();
</script>
</body>
</html>`;
