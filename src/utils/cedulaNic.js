/** Cédula NIC típica: 13 dígitos + letra; opcional sufijo /2, /3… para 2º registro. */
const CEDULA_RE = /^\d{13}[A-Z](\/\d+)?$/;

function normalizarCedula(input) {
  if (input == null) return '';
  return String(input).trim().toUpperCase().replace(/[-\s]/g, '');
}

function esFormatoCedulaNacional(cedula) {
  return CEDULA_RE.test(normalizarCedula(cedula));
}

function esCodigoSinDocumento(cedula) {
  return /^SINDOC-/i.test(String(cedula || ''));
}

function codigoSinDocumento(clienteId) {
  return `SINDOC-${String(clienteId || '').trim()}`;
}

/**
 * @param {string} input
 * @param {{ tipo?: 'nacional'|'extranjero', requerido?: boolean }} [opts]
 */
function validarCedula(input, opts = {}) {
  const tipo = opts.tipo === 'extranjero' ? 'extranjero' : 'nacional';
  const requerido = opts.requerido === true;
  const cedula = normalizarCedula(input);

  if (!cedula) {
    if (requerido) {
      return { ok: false, error: 'Documento requerido.', cedula: null };
    }
    return { ok: true, cedula: null, aviso: null, sin_documento: true };
  }

  if (cedula.length > 40) {
    return { ok: false, error: 'Documento demasiado largo (máx. 40 caracteres).', cedula };
  }

  let aviso = null;
  if (tipo === 'nacional' && !esFormatoCedulaNacional(cedula) && !esCodigoSinDocumento(cedula)) {
    aviso =
      'Formato NIC típico: 13 dígitos + letra (ej. 0012345678910A). Puede agregar /2 al final para un segundo cliente del mismo titular.';
  }

  return { ok: true, cedula, aviso, tipo };
}

module.exports = {
  normalizarCedula,
  validarCedula,
  esFormatoCedulaNacional,
  esCodigoSinDocumento,
  codigoSinDocumento,
  CEDULA_RE,
};
