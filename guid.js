// GUIDs IFC: o arquivo usa a forma compactada (22 caracteres, base64 própria do IFC);
// a API do visualizador usa a forma descompactada (UUID). Aqui convertemos e normalizamos.

const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** "0YvctVUKr0kugbFTf53O9L" -> "22e66dbf-8...". Retorna null se não for um GUID IFC válido. */
export function expandIfcGuid(g) {
  if (typeof g !== "string" || g.length !== 22) return null;
  let n = 0n;
  for (let i = 0; i < 22; i++) {
    const v = B64.indexOf(g[i]);
    if (v < 0 || (i === 0 && v > 3)) return null; // 1º caractere só carrega 2 bits
    n = i === 0 ? BigInt(v) : (n << 6n) | BigInt(v);
  }
  const h = n.toString(16).padStart(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UUID -> GUID IFC compactado (usado nos testes de ida e volta). */
export function compressIfcGuid(uuid) {
  const hex = String(uuid).replace(/[{}-]/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  let n = BigInt("0x" + hex);
  let out = "";
  for (let i = 0; i < 21; i++) {
    out = B64[Number(n & 63n)] + out;
    n >>= 6n;
  }
  return B64[Number(n)] + out;
}

/**
 * Forma canônica para comparar IDs vindos de lugares diferentes:
 * 32 dígitos hexadecimais minúsculos, sem hífen. Aceita GUID compactado ou UUID.
 * Outros formatos voltam como estão (comparação direta).
 */
export function canonGuid(id) {
  if (typeof id !== "string") return null;
  const s = id.trim();
  if (s.length === 22) {
    const e = expandIfcGuid(s);
    if (e) return e.replace(/-/g, "");
  }
  const hex = s.replace(/[{}-]/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : s;
}
