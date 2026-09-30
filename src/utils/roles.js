/** Roles operativos CrediCrece (panel / campo). */

const ROLES = {
  ADMIN: 'ADMIN',
  SUPERVISOR: 'SUPERVISOR',
  COBRADOR: 'COBRADOR',
  CONTADOR: 'CONTADOR',
};

const ROL_IDS = {
  ADMIN: 'ROL-ADMIN-UUID',
  SUPERVISOR: 'ROL-SUP-UUID',
  COBRADOR: 'ROL-COB-UUID',
  CONTADOR: 'ROL-CONT-UUID',
};

/** Panel admin + modo campo (cobros/cartera). */
function esAdminOperativo(rol) {
  const r = String(rol || '').toUpperCase();
  return r === ROLES.ADMIN || r === ROLES.SUPERVISOR;
}

/** Solo el dueño: permisos globales, respaldo SQL, etc. */
function esAdminDueno(rol) {
  return String(rol || '').toUpperCase() === ROLES.ADMIN;
}

const ROLES_CAMPO = [ROLES.COBRADOR, ROLES.ADMIN, ROLES.SUPERVISOR];

module.exports = {
  ROLES,
  ROL_IDS,
  esAdminOperativo,
  esAdminDueno,
  ROLES_CAMPO,
};
