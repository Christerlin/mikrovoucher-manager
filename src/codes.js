// Génération de codes : vouchers, références, PIN, jetons.
// Alphabet sans caractères ambigus (0/O, 1/I/L) pour la saisie manuelle.
import { randomInt, randomBytes, createHash, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode(length) {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

// Code voucher (username = password sur le hotspot).
export const generateVoucherCode = (length = 8) => randomCode(length);

// Référence de commande (transite par Pay'm — PAS un secret).
export function generateReference() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `VCH-${stamp}-${randomCode(8)}`;
}

// Secret opaque remis une seule fois au client au checkout (>=128 bits).
export const generateClaimToken = () => randomBytes(32).toString("base64url");

// Code de récupération court (~45 bits) — protégé par verrou par PIN côté serveur.
export const generateRetrievalPin = (length = 9) => randomCode(length);

// Jeton d'un routeur (agent pull).
export const generateRouterToken = () => randomBytes(24).toString("hex");

export const sha256 = (s) => createHash("sha256").update(String(s)).digest();

export function safeEqual(a, b) {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Durée RouterOS ("3d", "12h", "1w2d03:04:05", "23:59:00") -> secondes.
export function durationToSeconds(str) {
  str = String(str || "").trim();
  if (!str) return 0;
  const units = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0, m;
  const re = /(\d+)([wdhms])/g;
  while ((m = re.exec(str)) !== null) total += parseInt(m[1], 10) * units[m[2]];
  if (total === 0) {
    const p = str.split(":").map(Number);
    const ok = p.every((n) => !isNaN(n));
    if (p.length === 3 && ok) total = p[0] * 3600 + p[1] * 60 + p[2];
    else if (p.length === 2 && ok) total = p[0] * 60 + p[1];
  }
  return total;
}
