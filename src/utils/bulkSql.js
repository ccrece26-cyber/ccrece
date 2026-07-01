/** Inserciones multi-fila para reducir round-trips a TiDB. */

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function insertMany(conn, sqlPrefix, rows, chunkSize = 80) {
  if (!rows.length) return 0;
  let total = 0;
  for (const chunk of chunkArray(rows, chunkSize)) {
    const placeholders = chunk.map(() => sqlPrefix.placeholder).join(',');
    const values = chunk.flatMap((r) => sqlPrefix.values(r));
    await conn.execute(`${sqlPrefix.insert} VALUES ${placeholders}`, values);
    total += chunk.length;
  }
  return total;
}

/** UPDATE por lotes con CASE id → valor (misma semántica que N updates individuales). */
async function updateManyById(conn, { table, idCol, fields, rows, chunkSize = 120, extraSet = '' }) {
  if (!rows.length || !fields.length) return 0;
  const t = `\`${table}\``;
  const id = `\`${idCol}\``;
  const tail = extraSet ? `, ${extraSet}` : '';
  let total = 0;
  for (const chunk of chunkArray(rows, chunkSize)) {
    const ids = chunk.map((r) => r[idCol]);
    const sets = fields
      .map((field) => {
        const cases = chunk.map(() => `WHEN ? THEN ?`).join(' ');
        return `\`${field}\` = CASE ${id} ${cases} ELSE \`${field}\` END`;
      })
      .join(', ');
    const params = [];
    for (const field of fields) {
      for (const row of chunk) {
        params.push(row[idCol], row[field]);
      }
    }
    const ph = ids.map(() => '?').join(',');
    await conn.execute(
      `UPDATE ${t} SET ${sets}${tail}, updated_at = NOW() WHERE ${id} IN (${ph})`,
      [...params, ...ids]
    );
    total += chunk.length;
  }
  return total;
}

module.exports = { chunkArray, insertMany, updateManyById };
