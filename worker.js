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
      if (path === "/email/sync" && request.method === "POST") {
        return json(await syncZohoInbox(env));
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500);
    }
  },

  // Cron: فحص الموقع + مزامنة الإيميلات دوريًا
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWebsiteCheck(env));
    ctx.waitUntil(syncZohoInbox(env).catch(() => {}));
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
      zoho_message_id TEXT,
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
  const lastEmail = await env.DB.prepare(
    "SELECT * FROM email_log ORDER BY id DESC LIMIT 1"
  ).first();

  return {
    website: website || null,
    leads_total: leadsCount ? leadsCount.c : 0,
    emails_logged: emailCount ? emailCount.c : 0,
    last_email: lastEmail || null,
    zoho_connected: !!env.ZOHO_REFRESH_TOKEN,
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
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
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
    return { ok: false, error: "فشل تحليل الرد", raw: textBlocks || data };
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
// موظف الإيميلات — Zoho OAuth + قراءة الإنبوكس + مسودات رد بالذكاء الاصطناعي
// ============================================================
function buildZohoAuthUrl(env) {
  const params = new URLSearchParams({
    scope: "ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.accounts.READ",
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

  // ملاحظة: لازم تحفظ refresh_token يدويًا كـ Secret (ZOHO_REFRESH_TOKEN) بعد أول ربط
  return json(data);
}

// يجدد access_token من refresh_token المحفوظ (صالح دائمًا حتى تُلغى الصلاحية يدويًا)
async function getZohoAccessToken(env) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    refresh_token: env.ZOHO_REFRESH_TOKEN,
  });
  const resp = await fetch(
    `https://accounts.zoho.com/oauth/v2/token?${params.toString()}`,
    { method: "POST" }
  );
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error("فشل تجديد توكن Zoho: " + JSON.stringify(data));
  }
  return data.access_token;
}

async function getZohoAccountId(accessToken) {
  const resp = await fetch("https://mail.zoho.com/api/accounts", {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await resp.json();
  const account = data?.data?.[0];
  if (!account) throw new Error("لم يتم العثور على حساب Zoho Mail");
  return account.accountId;
}

// يجيب آخر الرسائل غير المقروءة، يلخصها ويسوي مسودة رد لكل وحدة، ويحفظها
async function syncZohoInbox(env) {
  if (!env.ZOHO_REFRESH_TOKEN) {
    return { ok: false, error: "Zoho غير مربوط بعد" };
  }

  const accessToken = await getZohoAccessToken(env);
  const accountId = await getZohoAccountId(accessToken);

  const listResp = await fetch(
    `https://mail.zoho.com/api/accounts/${accountId}/messages/view?limit=10&status=unread`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
  );
  const listData = await listResp.json();
  const messages = listData?.data || [];

  let processed = 0;
  for (const msg of messages) {
    // تجنّب التكرار — تحقق هل الرسالة معالجة مسبقًا
    const existing = await env.DB.prepare(
      "SELECT id FROM email_log WHERE zoho_message_id = ?"
    )
      .bind(msg.messageId)
      .first();
    if (existing) continue;

    const fromAddr = msg.fromAddress || msg.sender || "غير معروف";
    const subject = msg.subject || "(بدون عنوان)";
    const summarySnippet = msg.summary || "";

    const draft = await generateEmailDraftReply(env, fromAddr, subject, summarySnippet);

    await env.DB.prepare(
      `INSERT INTO email_log (created_at, zoho_message_id, from_addr, subject, summary, draft_reply) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        new Date().toISOString(),
        msg.messageId || "",
        fromAddr,
        subject,
        summarySnippet,
        draft
      )
      .run();
    processed++;
  }

  return { ok: true, checked: messages.length, new_processed: processed };
}

async function generateEmailDraftReply(env, fromAddr, subject, summary) {
  const prompt = `أنت مساعد إيميلات لشركة Tiger Event لتنظيم الفعاليات. وصلت رسالة:
من: ${fromAddr}
الموضوع: ${subject}
مقتطف: ${summary}

اكتب مسودة رد قصيرة ومهنية بالعربية (3-5 أسطر)، مناسبة لموضوع الرسالة. إذا كانت الرسالة استفسار عن خدمات، رحّب واطلب تفاصيل أكثر (نوع الفعالية، التاريخ، عدد الحضور). إذا كانت غير واضحة، اكتب ردًا عامًا مهذبًا. أعد فقط نص الرد بدون أي شرح إضافي.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await resp.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return text || "(تعذّر توليد مسودة رد)";
  } catch (e) {
    return "(خطأ أثناء توليد الرد: " + String(e) + ")";
  }
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
  button { background:#3b82f6; color:#fff; border:none; padding:8px 12px; border-radius:8px; font-size:13px; margin-top:8px; margin-inline-end:6px; }
  input, textarea { width:100%; box-sizing:border-box; background:#0f1115; color:#eee; border:1px solid #2a2e38; border-radius:8px; padding:8px; font-size:13px; margin-top:6px; }
  .email-item { border-top:1px solid #2a2e38; padding-top:8px; margin-top:8px; }
  .email-item small { color:#777; }
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
      \${s.last_email ? '<div class="email-item"><small>' + s.last_email.created_at + '</small><br><b>' + s.last_email.subject + '</b><br>من: ' + s.last_email.from_addr + '</div>' : ''}
      \${!s.zoho_connected
        ? '<button onclick="location.href=\\'/zoho/connect\\'">ربط Zoho</button>'
        : '<button onclick="syncEmail()">مزامنة الآن</button>'}
      <div id="emailResult"></div>
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
      <input id="sectorInput" placeholder="مثال: شركات تنظيم مؤتمرات بالكويت" />
      <button onclick="genLeads()">توليد قائمة</button>
      <div id="leadsResult"></div>
    </div>
  \`;
}

async function syncEmail() {
  document.getElementById('emailResult').innerText = 'جاري المزامنة...';
  const res = await fetch('/email/sync', { method: 'POST' });
  const data = await res.json();
  document.getElementById('emailResult').innerText = JSON.stringify(data);
  load();
}

async function genLeads() {
  const sector = document.getElementById('sectorInput').value;
  if (!sector) return;
  document.getElementById('leadsResult').innerText = 'جاري البحث...';
  const res = await fetch('/leads/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sector })
  });
  const data = await res.json();
  document.getElementById('leadsResult').innerText = data.ok
    ? 'تمت إضافة ' + data.added + ' شركة'
    : 'خطأ: ' + (data.error || '');
  load();
}
load();
</script>
</body>
</html>`;
