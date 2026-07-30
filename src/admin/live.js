// Script client de la fiche routeur : compte à rebours local + resynchronisation.
//
// Fichier servi tel quel (jamais inséré dans un template literal) : les
// échappements y survivent. Y remettre ce code dans une chaîne de gabarit
// casserait silencieusement les regex et les apostrophes.
(function () {
  var tag = document.getElementById("liveScript");
  if (!tag) return;
  var ROUTER_ID = tag.getAttribute("data-router-id");
  if (!ROUTER_ID) return;

  var UNITS = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };

  function toSeconds(str) {
    str = String(str || "").trim();
    if (!str) return null;
    var total = 0, m;
    var re = /(\d+)([wdhms])/g;
    while ((m = re.exec(str)) !== null) total += parseInt(m[1], 10) * UNITS[m[2]];
    if (total === 0) {
      var p = str.split(":").map(Number);
      var ok = p.every(function (n) { return !isNaN(n); });
      if (p.length === 3 && ok) total = p[0] * 3600 + p[1] * 60 + p[2];
      else if (p.length === 2 && ok) total = p[0] * 60 + p[1];
    }
    return total > 0 ? total : null;
  }

  function fmt(sec) {
    var d = Math.floor(sec / 86400); sec %= 86400;
    var h = Math.floor(sec / 3600); sec %= 3600;
    var mn = Math.floor(sec / 60), s = sec % 60;
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return (d > 0 ? d + "j " : "") + p(h) + ":" + p(mn) + ":" + p(s);
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " Go";
    if (n >= 1048576) return Math.round(n / 1048576) + " Mo";
    if (n >= 1024) return Math.round(n / 1024) + " Ko";
    return n + " o";
  }

  function mb(b) { return b > 0 ? Math.round(b / 1048576) + " Mo" : "–"; }

  function setText(id, txt) {
    var n = document.getElementById(id);
    if (n) n.textContent = txt;
  }

  var body = document.getElementById("sessBody");
  var count = document.getElementById("sessCount");

  // Construction par le DOM : les données viennent du routeur, on ne les
  // concatène jamais dans du HTML.
  function cell(text, cls) {
    var td = document.createElement("td");
    if (cls) td.className = cls;
    if (text != null) td.textContent = text;
    return td;
  }

  function renderRow(s) {
    var tr = document.createElement("tr");

    var code = cell(null, "mono");
    var strong = document.createElement("strong");
    strong.textContent = s.username;
    code.appendChild(strong);
    tr.appendChild(code);

    var plan = document.createElement("td");
    if (s.planLabel) {
      plan.textContent = s.planLabel;
      if (Number(s.devices) > 1) {
        var pill = document.createElement("span");
        pill.className = "pill wait";
        pill.textContent = s.devices + " app.";
        plan.appendChild(document.createTextNode(" "));
        plan.appendChild(pill);
      }
    } else {
      var muted = document.createElement("span");
      muted.style.color = "var(--ink-soft)";
      muted.textContent = "hors manager";
      plan.appendChild(muted);
    }
    tr.appendChild(plan);

    var left = toSeconds(s.timeLeft);
    var tl = document.createElement("td");
    tl.className = "mono";
    if (left) {
      var b = document.createElement("strong");
      b.setAttribute("data-left", left);
      b.textContent = fmt(left);
      tl.appendChild(b);
    } else {
      var inf = document.createElement("span");
      inf.style.color = "var(--ink-soft)";
      inf.textContent = "illimité";
      tl.appendChild(inf);
    }
    tr.appendChild(tl);

    tr.appendChild(cell(s.address || "–", "mono"));
    var mac = cell(s.mac || "–", "mono");
    mac.style.fontSize = "12px";
    tr.appendChild(mac);
    tr.appendChild(cell(s.uptime || "–", "mono"));
    tr.appendChild(cell(fmtBytes(s.bytesIn) + " / " + fmtBytes(s.bytesOut)));

    var act = document.createElement("td");
    var form = document.createElement("form");
    form.method = "post";
    form.action = "/admin/routers/" + ROUTER_ID + "/kick";
    form.style.margin = "0";
    form.setAttribute("data-confirm", "Déconnecter et supprimer " + s.username + " ?");
    var hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = "code";
    hidden.value = s.username;
    var btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Déconnecter";
    form.appendChild(hidden);
    form.appendChild(btn);
    act.appendChild(form);
    tr.appendChild(act);

    return tr;
  }

  function render(sessions) {
    if (count) count.textContent = sessions.length;
    body.textContent = "";
    if (sessions.length === 0) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 8;
      td.style.color = "var(--ink-soft)";
      td.textContent = "Aucun client connecté.";
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    sessions.forEach(function (s) { body.appendChild(renderRow(s)); });
  }

  // Compte à rebours local : une seconde à la fois, sans appel réseau.
  setInterval(function () {
    var nodes = body.querySelectorAll("[data-left]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var left = parseInt(el.getAttribute("data-left"), 10) - 1;
      if (left <= 0) {
        el.setAttribute("data-left", 0);
        el.textContent = "00:00:00";
      } else {
        el.setAttribute("data-left", left);
        el.textContent = fmt(left);
      }
    }
  }, 1000);

  // Resynchronisation avec les valeurs réelles du routeur.
  function sync() {
    fetch("/admin/api/routers/" + ROUTER_ID + "/live", {
      headers: { Accept: "application/json" },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (d.sessions) render(d.sessions);
        var i = d.info;
        if (i) {
          setText("iIdentity", i.identity || "–");
          setText("iBoard", i.board || "–");
          setText("iVersion", i.version || "–");
          setText("iUptime", i.uptime || "–");
          setText("iCpu", (i.cpuLoad || 0) + "%");
          setText("iMem", mb(i.freeMem) + " / " + mb(i.totalMem));
          setText("iActive", (i.activeUsers || 0) + " en ligne");
          setText("iUsers", String(i.totalUsers || 0));
        }
        var pill = document.getElementById("statePill");
        if (pill && d.lastSeen) {
          var age = (Date.now() - new Date(d.lastSeen).getTime()) / 1000;
          var span = document.createElement("span");
          span.className = age < 90 ? "pill ok" : "pill off";
          span.textContent = age < 90
            ? "En ligne"
            : "Hors ligne (" + Math.round(age / 60) + " min)";
          pill.textContent = "";
          pill.appendChild(span);
        }
      })
      .catch(function () { /* on retentera au prochain cycle */ });
  }

  setInterval(sync, 10000);
  sync();
})();
