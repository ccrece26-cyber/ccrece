require('dotenv').config();
const app = require('./app');
const { runStartupTasks } = require('./utils/startup');

const PORT = process.env.PORT || 3000;

if (!process.env.VERCEL) {
  app.listen(PORT, process.env.API_HOST || '0.0.0.0', () => {
    console.log(`\n🇳🇮 Microfinanzas API → TiDB Cloud :${PORT}`);
    console.log('   Admin:  /api/admin/*  (nube directa)');
    console.log('   Carga masiva: POST /api/admin/carga-masiva/validar | importar');
    console.log('   Respaldo:   GET  /api/admin/respaldo-sql');
    console.log('   Admin campo: GET /api/admin/campo/agenda | POST pago | gestion-no-pago');
    console.log('   Cobrador: /api/cobrador/ruta-diaria + sync/push\n');
    void runStartupTasks();
  });
}

module.exports = app;
