require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');
const { hoyISO } = require('../utils/zonaHoraria');
const { whereCierreCalendarioDia } = require('../utils/fechasSql');

const fecha = process.argv[2] || hoyISO();

(async () => {
  const vielka = await query(
    `SELECT u.id, u.nombre_completo FROM Usuarios u
     WHERE u.nombre_completo LIKE '%Vielka%' LIMIT 1`
  );
  if (!vielka.length) {
    console.log('Cobrador Vielka no encontrado');
    process.exit(1);
  }
  const cobId = vielka[0].id;
  const r = await query(
    `UPDATE Cierre_Caja SET deleted_at = NOW(), updated_at = NOW()
     WHERE cobrador_id = ? AND deleted_at IS NULL AND ${whereCierreCalendarioDia('fecha_cierre')}`,
    [cobId, fecha]
  );
  console.log('Reabierto cierre de', vielka[0].nombre_completo, 'fecha', fecha, '| filas:', r.affectedRows ?? r);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
