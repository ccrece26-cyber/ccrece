require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');

const filtro = process.argv[2] || '%Carmen%Altares%';

(async () => {
  const clientes = await query(
    `SELECT id, nombre_completo, cedula, cobrador_id
     FROM Clientes
     WHERE deleted_at IS NULL AND nombre_completo LIKE ?
     ORDER BY id`,
    [filtro]
  );
  if (!clientes.length) {
    console.log('Sin clientes para:', filtro);
    process.exit(0);
  }
  for (const c of clientes) {
    console.log('\n===', c.id, c.nombre_completo, c.cedula, 'cobrador:', c.cobrador_id);
    const prestamos = await query(
      `SELECT id, estado, saldo_pendiente, monto_desembolsado, fecha_desembolso,
              renovacion_previa_id, deleted_at, updated_at
       FROM Prestamos WHERE cliente_id = ? ORDER BY fecha_desembolso DESC`,
      [c.id]
    );
    for (const p of prestamos) {
      console.log('  ', p.id, p.estado, 'saldo:', p.saldo_pendiente, 'desembolso:', p.fecha_desembolso, 'del:', p.deleted_at);
    }
    const activo = prestamos.find((p) => p.estado === 'Activo' && !p.deleted_at);
    console.log('  ACTIVO:', activo ? activo.id : 'NINGUNO');
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
