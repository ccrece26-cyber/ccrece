require('dotenv').config({ path: require('path').join(__dirname, '../../.env.nuevo') });
const { query, pool } = require('../config/db');

(async () => {
  const alters = [
    "ALTER TABLE Clientes ADD COLUMN documento_tipo VARCHAR(20) DEFAULT 'nacional'",
    'ALTER TABLE Clientes MODIFY COLUMN cedula VARCHAR(40) NOT NULL',
  ];
  for (const sql of alters) {
    try {
      await query(sql);
      console.log('OK:', sql.slice(0, 60));
    } catch (e) {
      console.log('SKIP:', e.message);
    }
  }
  await pool.end();
})();
