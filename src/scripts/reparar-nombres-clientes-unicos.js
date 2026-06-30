/**
 * Nombres únicos estilo nicaragüense (sin números en apellidos).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');

const PRIMEROS = [
  'Maria', 'Jose', 'Ana', 'Carlos', 'Lucia', 'Pedro', 'Rosa', 'Oscar', 'Carmen', 'Luis',
  'Patricia', 'Miguel', 'Sandra', 'Francisco', 'Glenda', 'Walter', 'Yolanda', 'Marvin', 'Xiomara', 'Boris',
  'Norma', 'Ricardo', 'Silvia', 'Ernesto', 'Adela', 'Hector', 'Olga', 'Sergio', 'Irma', 'Alfredo',
  'Edgar', 'Paula', 'Gilberto', 'Moises', 'Teresa', 'Abel', 'Danilo', 'Elmer', 'Noel', 'Karla',
  'Domingo', 'Flor', 'Cesar', 'Darwin', 'Efrain', 'Israel', 'Maximo', 'Wilmer', 'Samuel', 'Ulises',
];

const SEGUNDOS = [
  'Elena', 'Alberto', 'Beatriz', 'Daniel', 'Marina', 'Antonio', 'Isabel', 'Javier', 'Marisol', 'Josefina',
  'Alejandra', 'Angel', 'Patricia', 'Luis', 'Cristina', 'Antonio', 'Ivan', 'Lucia', 'Eduardo', 'Reyna',
  'Raul', 'Marta', 'Victor', 'Griselda', 'Yadira', 'Marlen', 'Susana', 'Araceli', 'Mercedes', 'Ligia',
  'Vanessa', 'Evelyn', 'Gloria', 'Ingrid', 'Julissa', 'Maribel', 'Nancy', 'Rocio', 'Estela', 'Veronica',
  'Diana', 'Angela', 'Claudia', 'Miriam', 'Gladys', 'Esperanza', 'Aurora', 'Jackeline', 'Leticia', 'Sonia',
];

const APELLIDOS1 = [
  'Lopez', 'Garcia', 'Martinez', 'Rivas', 'Mejia', 'Torres', 'Zelaya', 'Baltodano', 'Corea', 'Jarquin',
  'Urbina', 'Tellez', 'Blandon', 'Guido', 'Duarte', 'Gutierrez', 'Centeno', 'Montenegro', 'Flores', 'Herrera',
  'Castillo', 'Navarro', 'Chavez', 'Morales', 'Ortega', 'Pineda', 'Ramos', 'Cruz', 'Reyes', 'Silva',
  'Aguilar', 'Delgado', 'Ruiz', 'Vargas', 'Jimenez', 'Mendoza', 'Suarez', 'Espinoza', 'Perez', 'Rodriguez',
  'Gonzalez', 'Ramirez', 'Sanchez', 'Diaz', 'Romero', 'Alvarez', 'Medina', 'Cordero', 'Palacios', 'Benavides',
];

const APELLIDOS2 = [
  'Ruiz', 'Herrera', 'Castillo', 'Navarro', 'Chavez', 'Morales', 'Ortega', 'Pineda', 'Ramos', 'Cruz',
  'Reyes', 'Silva', 'Aguilar', 'Delgado', 'Vargas', 'Jimenez', 'Mendoza', 'Suarez', 'Espinoza', 'Perez',
  'Rodriguez', 'Gonzalez', 'Ramirez', 'Sanchez', 'Diaz', 'Romero', 'Alvarez', 'Medina', 'Cordero', 'Palacios',
  'Benavides', 'Zamora', 'Urbina', 'Guido', 'Duarte', 'Centeno', 'Montenegro', 'Flores', 'Blandon', 'Tellez',
  'Jarquin', 'Corea', 'Baltodano', 'Zelaya', 'Torres', 'Mejia', 'Rivas', 'Martinez', 'Garcia', 'Lopez',
];

function buildPool(min = 220) {
  const pool = [];
  const usados = new Set();
  outer: for (let a = 0; a < PRIMEROS.length; a += 1) {
    for (let b = 0; b < SEGUNDOS.length; b += 1) {
      for (let c = 0; c < APELLIDOS1.length; c += 1) {
        for (let d = 0; d < APELLIDOS2.length; d += 1) {
          const nom = {
            primer_nombre: PRIMEROS[a],
            segundo_nombre: SEGUNDOS[b],
            primer_apellido: APELLIDOS1[c],
            segundo_apellido: APELLIDOS2[d],
          };
          nom.nombre_completo = [nom.primer_nombre, nom.segundo_nombre, nom.primer_apellido, nom.segundo_apellido]
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          const key = nom.nombre_completo.toLowerCase();
          if (usados.has(key)) continue;
          usados.add(key);
          pool.push(nom);
          if (pool.length >= min) break outer;
        }
      }
    }
  }
  if (pool.length < min) throw new Error(`Solo ${pool.length} nombres únicos generados`);
  return pool;
}

const POOL = buildPool(220);

function nombreUnico(i) {
  return POOL[i];
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const clientes = await query(
    `SELECT id, nombre_completo FROM Clientes WHERE deleted_at IS NULL ORDER BY id`
  );
  console.log(`Clientes: ${clientes.length}${dryRun ? ' (dry-run)' : ''}`);

  let ok = 0;
  for (let i = 0; i < clientes.length; i++) {
    const c = clientes[i];
    const nom = nombreUnico(i);
    if (dryRun && i < 10) {
      console.log(`${c.id} → ${nom.nombre_completo}`);
    }
    if (!dryRun) {
      await query(
        `UPDATE Clientes SET primer_nombre=?, segundo_nombre=?, primer_apellido=?, segundo_apellido=?,
           nombre_completo=?, is_synced=1, updated_at=NOW() WHERE id=?`,
        [nom.primer_nombre, nom.segundo_nombre, nom.primer_apellido, nom.segundo_apellido, nom.nombre_completo, c.id]
      );
    }
    ok++;
  }

  if (!dryRun) {
    const [dup] = await query(
      `SELECT COUNT(*) n FROM (
         SELECT LOWER(TRIM(nombre_completo)) nom FROM Clientes WHERE deleted_at IS NULL
         GROUP BY LOWER(TRIM(nombre_completo)) HAVING COUNT(*)>1
       ) t`
    );
    console.log(`\n✅ ${ok} nombres actualizados. Duplicados restantes: ${dup.n}`);
  } else {
    console.log(`\n✅ ${ok} simulados.`);
  }
}

main()
  .catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
