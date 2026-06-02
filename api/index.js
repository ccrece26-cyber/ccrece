/**
 * Entrada serverless para Vercel.
 * No ejecuta app.listen — Vercel enruta el tráfico aquí.
 */
const app = require('../src/app');

if (process.env.VERCEL && process.env.SKIP_STARTUP_TASKS !== '0') {
  process.env.SKIP_STARTUP_TASKS = '1';
}

module.exports = app;
