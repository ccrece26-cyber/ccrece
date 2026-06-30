require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../config/db');

const alters = [
  'ALTER TABLE Usuarios ADD COLUMN expo_push_token VARCHAR(255) DEFAULT NULL',
  'ALTER TABLE Usuarios ADD COLUMN push_token_at DATETIME DEFAULT NULL',
  'ALTER TABLE Pagos ADD COLUMN editado_por_admin_at DATETIME DEFAULT NULL',
];

(async () => {
  for (const sql of alters) {
    try {
      await query(sql);
      console.log('OK:', sql.slice(0, 60));
    } catch (e) {
      console.log('SKIP:', e.message?.slice(0, 80));
    }
  }
  const cols = await query("SHOW COLUMNS FROM Usuarios LIKE 'expo_push_token'");
  console.log('expo_push_token:', cols.length ? 'presente' : 'FALTA');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
