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
