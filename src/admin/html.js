// Mise en page du dashboard — zéro dépendance, thème "papier/billet"
// hérité du portail (cohérence visuelle avec les pages hotspot).

export function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// `side` : menu vertical d'une section (les pages d'un meme routeur, par
// exemple). Il evite la page fourre-tout ou tout s'empile.
export function layout(title, body, { active = "", side = null } = {}) {
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
<script>
// Appliqué avant le premier rendu : sinon la page clignote au chargement.
try {
  var t = localStorage.getItem("mvm-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
</script>
<style>
/* Palette validée pour les deux modes (contraste, bande de clarté, écart
   perceptuel entre statuts sous daltonisme). Ne pas retoucher à l'oeil :
   repasser par scripts/validate_palette.js du guide dataviz.
   Le vert est la couleur d'action ; les statuts vivent sur d'autres teintes
   pour qu'un bouton vert ne se lise pas comme "tout va bien".
   Le clair est la base — mêmes couleurs que le portail, lisible dehors. */
:root{
  --paper:#eef2ef; --card:#ffffff; --ink:#111c17; --ink-soft:#5c7268;
  --line:#dde5e0; --accent:#16a34a; --accent-dark:#15803d;
  --ok:#0891b2; --warn:#d97706; --err:#e11d48;
  --grain:rgba(17,28,23,.04); --shadow:rgba(17,28,23,.10);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme]){
    --paper:#0b0f0d; --card:#151b18; --ink:#e6efe9; --ink-soft:#8ea69a;
    --line:#26312c; --accent:#16a34a; --accent-dark:#15803d;
    --ok:#0891b2; --warn:#d97706; --err:#e11d48;
    --grain:rgba(255,255,255,.03); --shadow:rgba(0,0,0,.4);
  }
}
:root[data-theme="dark"]{
  --paper:#0b0f0d; --card:#151b18; --ink:#e6efe9; --ink-soft:#8ea69a;
  --line:#26312c; --accent:#16a34a; --accent-dark:#15803d;
  --ok:#0891b2; --warn:#d97706; --err:#e11d48;
  --grain:rgba(255,255,255,.03); --shadow:rgba(0,0,0,.4);
}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
  background:var(--paper);color:var(--ink);
  background-image:radial-gradient(var(--grain) 1px, transparent 1.2px);
  background-size:15px 15px}
/* Menu vertical de section : la colonne reste visible pendant qu'on
   fait defiler la page, comme l'arbre de menus de WinBox. */
.split{display:grid;grid-template-columns:210px minmax(0,1fr);gap:22px;align-items:start}
.side{position:sticky;top:16px;background:var(--card);border:1px solid var(--line);
  border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:2px}
.side-title{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  color:var(--ink-soft);padding:6px 10px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side a{padding:9px 12px;border-radius:9px;text-decoration:none;color:var(--ink);
  font-size:14px;font-weight:600}
.side a:hover{background:var(--paper)}
.side a.on{background:var(--accent);color:#fff}
.side-back{margin-top:8px;border-top:1px solid var(--line);border-radius:0;
  padding-top:12px !important;color:var(--ink-soft) !important;font-weight:600;font-size:13px}
.side-back:hover{background:none !important;color:var(--ink) !important}
.pane{min-width:0}

header{display:flex;align-items:center;gap:18px;padding:14px 22px;
  background:var(--card);border-bottom:1px solid var(--line)}
header .brand{font-family:Georgia,serif;font-weight:700;font-size:17px}
header nav{display:flex;gap:4px;flex:1}
header nav a{padding:7px 14px;border-radius:999px;text-decoration:none;color:var(--ink-soft);font-size:14px;font-weight:600}
header nav a.on{background:var(--accent);color:#fff}
header form{margin:0}
#themeBtn{background:transparent;border:1.5px solid var(--line);color:var(--ink-soft);
  padding:7px 12px;line-height:1;font-size:15px}
#themeBtn:hover{background:transparent;border-color:var(--accent);color:var(--accent)}
main{max-width:1000px;margin:26px auto;padding:0 18px;overflow-x:clip}
h1{font-family:Georgia,serif;font-size:22px;margin:0 0 4px}
h2{font-family:Georgia,serif;font-size:17px;margin:26px 0 10px}
.sub{color:var(--ink-soft);font-size:13px;margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:18px 20px;margin-bottom:18px;box-shadow:0 4px 16px var(--shadow)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);
  text-align:left;padding:8px 8px;border-bottom:1px solid var(--line)}
td{padding:9px 8px;border-bottom:1px dotted var(--line)}
tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,'SF Mono',Consolas,monospace}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}
.pill.ok{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.pill.off{background:color-mix(in srgb,var(--err) 16%,transparent);color:var(--err)}
.pill.wait{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
input,select{padding:9px 11px;border:1px solid var(--line);border-radius:9px;
  background:var(--paper);font-size:14px;color:var(--ink)}
input:focus,select:focus{outline:none;border-color:var(--accent)}
button,.btn{display:inline-block;padding:9px 18px;border:0;border-radius:999px;
  background:var(--accent);color:#fff;font-weight:700;font-size:13px;cursor:pointer;
  text-decoration:none;text-transform:uppercase;letter-spacing:.04em}
button:hover,.btn:hover{background:var(--accent-dark)}
button.ghost,.btn.ghost{background:transparent;color:var(--accent);border:1.5px solid var(--line)}
button.danger{background:var(--err);color:#fff;border:0}
button.danger:hover{filter:brightness(.9)}
form.inline{display:flex;gap:10px;flex-wrap:wrap;align-items:end}
form.inline label{display:flex;flex-direction:column;gap:4px;font-size:11px;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);font-weight:700}
textarea{width:100%;min-height:220px;font-family:ui-monospace,Consolas,monospace;
  font-size:12px;border:1px solid var(--line);border-radius:9px;background:var(--paper);
  color:var(--ink);padding:10px}
.err-msg{color:var(--err);font-weight:700;font-size:14px}
a{color:var(--accent)}
/* --- Finances : tuiles + graphique ------------------------------------- */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  gap:12px;margin-bottom:18px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:14px 16px;box-shadow:0 4px 16px var(--shadow)}
.kpi-label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-soft);font-weight:700}
/* Chiffre vedette : même sans que le reste, chiffres proportionnels. */
.kpi-value{font-size:20px;font-weight:700;margin:6px 0 2px;line-height:1.15;
  font-variant-numeric:proportional-nums;overflow-wrap:anywhere}
.kpi-unit{font-size:12px;font-weight:700;color:var(--ink-soft);margin-left:4px;
  white-space:nowrap}
.kpi-detail{font-size:12px;color:var(--ink-soft)}

.chart{margin-top:14px}
.plot{position:relative;height:170px;margin-bottom:6px}
/* Repères : traits pleins, une nuance au-dessus de la surface. */
.gridline{position:absolute;left:0;right:0;border-top:1px solid var(--line);
  pointer-events:none}
.gridline span{position:absolute;right:0;top:-9px;background:var(--card);
  padding-left:6px;font-size:10px;color:var(--ink-soft);
  font-variant-numeric:tabular-nums}
.bars{position:absolute;inset:0;display:flex;align-items:flex-end;gap:2px}
.bar-slot{position:relative;flex:1;height:100%;display:flex;align-items:flex-end;
  min-width:6px;outline:none}
.bar{width:100%;background:var(--accent);border-radius:4px 4px 0 0;min-height:2px;
  transition:background .15s}
.bar-slot:hover .bar,.bar-slot:focus .bar{background:var(--accent-dark)}
.bar-slot:focus-visible{box-shadow:0 0 0 2px var(--accent)}
.bar-slot:focus .bar-tip{opacity:1}
/* Info-bulle : complément, jamais le seul accès à la valeur (voir tableau). */
.bar-tip{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);
  background:var(--ink);color:var(--paper);padding:6px 9px;border-radius:8px;
  font-size:11px;line-height:1.35;white-space:nowrap;opacity:0;pointer-events:none;
  transition:opacity .12s;z-index:5}
.bar-slot:hover .bar-tip,.bar-slot:focus .bar-tip{opacity:1}
.xaxis{display:flex;justify-content:space-between;gap:10px;font-size:11px;
  color:var(--ink-soft)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}

.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}

/* --- Mobile : le dashboard sert aussi depuis un téléphone --- */
@media (max-width:760px){
  .grid2{grid-template-columns:1fr}
  /* Sous 900 px la colonne passe au-dessus, en rangee defilante. */
  .split{grid-template-columns:1fr;gap:14px}
  .side{position:static;flex-direction:row;overflow-x:auto;padding:8px}
  .side a{white-space:nowrap}
  .side-title{display:none}
  .side-back{margin-top:0;border-top:none;border-left:1px solid var(--line);padding-top:9px !important}

  header{flex-wrap:wrap;gap:10px;padding:12px 14px}
  header nav{order:3;width:100%;overflow-x:auto}
  header nav a{white-space:nowrap}
  main{margin:16px auto;padding:0 12px}
  h1{font-size:19px}
  .card{padding:14px 14px}
  .kpis{grid-template-columns:repeat(2,1fr);gap:10px}
  .kpi-value{font-size:18px}
  .plot{height:140px}
  /* Les tableaux larges défilent dans leur carte au lieu de déborder. */
  .card table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .card table td,.card table th{white-space:nowrap}
  /* Formulaires : un champ par ligne, boutons pleine largeur. */
  form.inline{flex-direction:column;align-items:stretch}
  form.inline label{width:100%}
  form.inline input,form.inline select{width:100%}
  form.inline button{width:100%}
  textarea{min-height:160px;font-size:11px}
  /* Confort tactile. */
  button,.btn{padding:11px 18px}
  button.danger{padding:9px 14px}
}
</style>
</head>
<body>
<header>
  <span class="brand">Mikrovoucher</span>
  <nav>${nav}</nav>
  <button id="themeBtn" type="button" title="Changer de thème" aria-label="Changer de thème">◐</button>
  <form method="post" action="/admin/logout"><button class="ghost">Quitter</button></form>
</header>
<main>${side ? `
  <div class="split">
    <aside class="side">
      <div class="side-title">${esc(side.titre)}</div>
      ${side.items.map(([href, label, key]) =>
        `<a href="${href}" class="${side.actif === key ? "on" : ""}">${label}</a>`).join("")}
      ${side.retour ? `<a class="side-back" href="${side.retour}">&larr; Tous les routeurs</a>` : ""}
    </aside>
    <div class="pane">${body}</div>
  </div>` : body}</main>
<script>
// Bascule clair/sombre. Sans choix enregistré, on suit le réglage du système.
(function () {
  var btn = document.getElementById("themeBtn");
  if (!btn) return;
  function actuel() {
    if (document.documentElement.dataset.theme) return document.documentElement.dataset.theme;
    // Sans choix enregistré : clair par défaut, sombre si le système le demande.
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  btn.addEventListener("click", function () {
    var suivant = actuel() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = suivant;
    try { localStorage.setItem("mvm-theme", suivant); } catch (e) {}
  });
})();

// Confirmations : le texte vit dans data-confirm (contexte attribut HTML,
// correctement échappé). On n'injecte jamais de données dans du JS inline —
// un simple apostrophe y suffirait à casser, voire détourner, le handler.
document.addEventListener("submit", function (e) {
  var msg = e.target && e.target.dataset ? e.target.dataset.confirm : null;
  if (msg && !confirm(msg)) e.preventDefault();
}, true);
</script>
</body>
</html>`;
}
