/**
 * Asigna nombres únicos a clientes demo (carga masiva con plantillas repetidas).
 * Uso: node src/scripts/reparar-nombres-clientes-unicos.js
 *      node src/scripts/reparar-nombres-clientes-unicos.js --dry-run
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');

const VARIANTES = [
  'Antonio', 'Rosa', 'Luis', 'Carmen', 'Jorge', 'Lucia', 'Ricardo', 'Silvia', 'Ernesto', 'Adela',
  'Hector', 'Norma', 'Raul', 'Olga', 'Sergio', 'Irma', 'Alfredo', 'Marta', 'Victor', 'Nora',
  'Edgar', 'Paula', 'Gilberto', 'Reyna', 'Moises', 'Teresa', 'Abel', 'Griselda', 'Danilo', 'Xenia',
  'Elmer', 'Yadira', 'Noel', 'Marlen', 'Oswaldo', 'Karla', 'Reynaldo', 'Susana', 'Domingo', 'Araceli',
  'Benjamin', 'Flor', 'Cesar', 'Jackeline', 'Darwin', 'Mercedes', 'Efrain', 'Ligia', 'Israel', 'Vanessa',
  'Maximo', 'Evelyn', 'Adan', 'Gloria', 'Wilmer', 'Ingrid', 'Samuel', 'Julissa', 'Tomas', 'Maribel',
  'Ulises', 'Nancy', 'Fabio', 'Rocio', 'Gonzalo', 'Estela', 'Ignacio', 'Veronica', 'Ramiro', 'Leticia',
  'Emilio', 'Diana', 'Fidel', 'Angela', 'Julio', 'Beatriz', 'Marcos', 'Claudia', 'Nestor', 'Patricia',
  'Alvaro', 'Sonia', 'Rodrigo', 'Miriam', 'Salvador', 'Gladys', 'Timoteo', 'Esperanza', 'Bernardo', 'Aurora',
];

function numId(id) {
  const m = String(id).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

function nombreUnico(i) {
  const a = VARIANTES[i % VARIANTES.length];
  const b = VARIANTES[(i * 7 + 3) % VARIANTES.length];
  const c = VARIANTES[(i * 13 + 5) % VARIANTES.length];
  const base = VARIANTES[(i * 19 + 11) % VARIANTES.length];
  const d = `${base}${String(i + 1).padStart(3, '0')}`;
  const nombre_completo = `${a} ${b} ${c} ${d}`;
  return {
    primer_nombre: a,
    segundo_nombre: b,
    primer_apellido: c,
    segundo_apellido: d,
    nombre_completo,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const clientes = await query(
    `SELECT id, nombre_completo, cedula, cobrador_id FROM Clientes
     WHERE deleted_at IS NULL ORDER BY id`
  );
  console.log(`Clientes: ${clientes.length}${dryRun ? ' (dry-run)' : ''}\n`);

  const dupAntes = await query(
    `SELECT LOWER(TRIM(nombre_completo)) nom, COUNT(*) n
     FROM Clientes WHERE deleted_at IS NULL
     GROUP BY LOWER(TRIM(nombre_completo)) HAVING n > 1`
  );
  console.log('Grupos de nombre duplicado antes:', dupAntes.length);

  let ok = 0;
  for (let i = 0; i < clientes.length; i++) {
    const c = clientes[i];
    const nom = nombreUnico(i);
    if (dryRun && i < 12) {
      console.log(`${c.id} | ${c.nombre_completo} → ${nom.nombre_completo}`);
    }
    if (!dryRun) {
      await query(
        `UPDATE Clientes SET
           primer_nombre = ?, segundo_nombre = ?, primer_apellido = ?, segundo_apellido = ?,
           nombre_completo = ?, is_synced = 1, updated_at = NOW()
         WHERE id = ?`,
        [nom.primer_nombre, nom.segundo_nombre, nom.primer_apellido, nom.segundo_apellido, nom.nombre_completo, c.id]
      );
    }
    ok++;
  }

  const dupDespues = dryRun
    ? [{ n: '?' }]
    : await query(
        `SELECT COUNT(*) AS n FROM (
           SELECT LOWER(TRIM(nombre_completo)) nom FROM Clientes WHERE deleted_at IS NULL
           GROUP BY LOWER(TRIM(nombre_completo)) HAVING COUNT(*) > 1
         ) t`
      );

  console.log(`\n✅ ${ok} clientes ${dryRun ? 'simulados' : 'actualizados'}.`);
  if (!dryRun) {
    console.log('Grupos duplicados después:', dupDespues[0]?.n ?? 0);
    const oscar = await query(
      `SELECT c.id, c.nombre_completo, c.cedula FROM Clientes c
       JOIN Ruta_Clientes rc ON rc.cliente_id = c.id
       JOIN Rutas r ON r.id = rc.ruta_id AND r.cobrador_id = (
         SELECT id FROM Usuarios WHERE email = 'cobrador2' LIMIT 1
       )
       ORDER BY c.id LIMIT 8`
    );
    console.log('\nMuestra ruta cobrador2 (primeros 8):');
    oscar.forEach((r) => console.log(`  ${r.id} ${r.nombre_completo} ${r.cedula}`));
  }
}

main()
  .catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
