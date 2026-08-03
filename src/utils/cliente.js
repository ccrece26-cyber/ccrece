function nombreCompleto(c) {
  const parts = [
    c.primer_nombre,
    c.segundo_nombre,
    c.primer_apellido,
    c.segundo_apellido,
  ].filter(Boolean);
  if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').trim();
  return c.nombre_completo || '';
}

/**
 * Separa nombre completo nicaragüense típico:
 * 1: nombre | 2: nombre apellido | 3: 2 nombres + 1 apellido | 4+: 2 nombres + 2 apellidos
 * Sufijo de duplicado (/2) se conserva en nombre_completo, no en las partes.
 */
function splitNombreCompleto(raw) {
  let full = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!full) {
    return {
      primer_nombre: null,
      segundo_nombre: null,
      primer_apellido: null,
      segundo_apellido: null,
      nombre_completo: null,
    };
  }
  const suf = full.match(/\s+(\/\d+)$/);
  if (suf) full = full.slice(0, -suf[0].length).trim();
  const p = full.split(' ').filter(Boolean);
  let primer_nombre = null;
  let segundo_nombre = null;
  let primer_apellido = null;
  let segundo_apellido = null;
  if (p.length === 1) {
    primer_nombre = p[0];
  } else if (p.length === 2) {
    primer_nombre = p[0];
    primer_apellido = p[1];
  } else if (p.length === 3) {
    primer_nombre = p[0];
    segundo_nombre = p[1];
    primer_apellido = p[2];
  } else if (p.length === 4) {
    primer_nombre = p[0];
    segundo_nombre = p[1];
    primer_apellido = p[2];
    segundo_apellido = p[3];
  } else {
    primer_nombre = p[0];
    segundo_nombre = p.slice(1, -2).join(' ');
    primer_apellido = p[p.length - 2];
    segundo_apellido = p[p.length - 1];
  }
  const nombre_completo = [primer_nombre, segundo_nombre, primer_apellido, segundo_apellido]
    .filter(Boolean)
    .join(' ');
  return {
    primer_nombre,
    segundo_nombre,
    primer_apellido,
    segundo_apellido,
    nombre_completo: suf ? `${nombre_completo} ${suf[1]}`.trim() : nombre_completo,
  };
}

module.exports = { nombreCompleto, splitNombreCompleto };
