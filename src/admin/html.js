// Mise en page du dashboard — zéro dépendance, thème "papier/billet"
// hérité du portail (cohérence visuelle avec les pages hotspot).

export function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function layout(title, body, { active = "" } = {}) {
  const nav = [
    ["/admin/routers", "Routeurs", "routers"],
    ["/admin/orders", "Ventes", "orders"],
  ].map(([href, label, key]) =>
    `<a href="${href}" class="${active === key ? "on" : ""}">${label}</a>`).join("");

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Mikrovoucher</title>
<style>
:root{
  --paper:#f2e6cf; --card:#fffaf0; --ink:#241b13; --ink-soft:#8a7455;
  --line:#d9c49b; --accent:#c2410c; --accent-dark:#9a3412; --ok:#0d6b52; --err:#9c2b1f;
}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
  background:var(--paper);color:var(--ink);
  background-image:radial-gradient(rgba(36,27,19,.05) 1px, transparent 1.2px);
  background-size:15px 15px}
header{display:flex;align-items:center;gap:18px;padding:14px 22px;
  background:var(--card);border-bottom:1px solid var(--line)}
header .brand{font-family:Georgia,serif;font-weight:700;font-size:17px}
header nav{display:flex;gap:4px;flex:1}
header nav a{padding:7px 14px;border-radius:999px;text-decoration:none;color:var(--ink-soft);font-size:14px;font-weight:600}
header nav a.on{background:var(--accent);color:#fff}
header form{margin:0}
main{max-width:1000px;margin:26px auto;padding:0 18px}
h1{font-family:Georgia,serif;font-size:22px;margin:0 0 4px}
h2{font-family:Georgia,serif;font-size:17px;margin:26px 0 10px}
.sub{color:var(--ink-soft);font-size:13px;margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:18px 20px;margin-bottom:18px;box-shadow:0 4px 16px rgba(36,27,19,.07)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);
  text-align:left;padding:8px 8px;border-bottom:1px solid var(--line)}
td{padding:9px 8px;border-bottom:1px dotted var(--line)}
tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,'SF Mono',Consolas,monospace}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}
.pill.ok{background:rgba(13,107,82,.12);color:var(--ok)}
.pill.off{background:rgba(156,43,31,.12);color:var(--err)}
.pill.wait{background:rgba(180,83,9,.14);color:#92400e}
input,select{padding:9px 11px;border:1px solid var(--line);border-radius:9px;
  background:#fffdf7;font-size:14px;color:var(--ink)}
input:focus,select:focus{outline:none;border-color:var(--accent)}
button,.btn{display:inline-block;padding:9px 18px;border:0;border-radius:999px;
  background:var(--accent);color:#fff;font-weight:700;font-size:13px;cursor:pointer;
  text-decoration:none;text-transform:uppercase;letter-spacing:.04em}
button:hover,.btn:hover{background:var(--accent-dark)}
button.ghost,.btn.ghost{background:transparent;color:var(--accent);border:1.5px solid var(--line)}
button.danger{background:var(--err);color:#fff;border:0}
button.danger:hover{background:#7a2117}
form.inline{display:flex;gap:10px;flex-wrap:wrap;align-items:end}
form.inline label{display:flex;flex-direction:column;gap:4px;font-size:11px;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);font-weight:700}
textarea{width:100%;min-height:220px;font-family:ui-monospace,Consolas,monospace;
  font-size:12px;border:1px solid var(--line);border-radius:9px;background:#fffdf7;padding:10px}
.err-msg{color:var(--err);font-weight:700;font-size:14px}
a{color:var(--accent)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:700px){.grid2{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <span class="brand">Mikrovoucher</span>
  <nav>${nav}</nav>
  <form method="post" action="/admin/logout"><button class="ghost">Quitter</button></form>
</header>
<main>${body}</main>
</body>
</html>`;
}
