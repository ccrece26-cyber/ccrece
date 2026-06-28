require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { login, cambiarPassword } = require('./routes/auth');
const { syncMasivo } = require('./routes/pagos');
const { pullChanges, pushGestiones, healthCheck } = require('./routes/sync');
const admin = require('./routes/admin');
const adminCampo = require('./routes/adminCampo');
const cobrador = require('./routes/cobrador');
const licencia = require('./routes/licencia');
const { guardEscrituraActiva } = require('./middleware/guardEscrituraActiva');

const app = express();

app.use(cors());
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '4mb' }));

app.get('/', (req, res) => {
  res.json({
    service: 'apiCrediCrece',
    health: '/api/health',
    docs: 'https://github.com/delveraz/apiCrediCrece',
  });
});

/** Rutas públicas (sin X-Operador-Id) — deben ir ANTES del guard. */
app.get('/api/health', healthCheck);
app.get('/api/status', healthCheck);
app.post('/api/auth/login', login);
app.post('/api/auth/cambiar-password', cambiarPassword);
app.post('/api/licencia/solicitar', licencia.solicitarCodigo);
app.post('/api/licencia/verificar', licencia.verificarCodigo);
app.get('/api/licencia/estado', licencia.estadoLicencia);

app.use('/api', guardEscrituraActiva);

app.get('/api/admin/cumplimiento-ruta', admin.getCumplimientoRuta);
app.post('/api/admin/cierre-caja/reabrir', admin.reabrirCierreCajaDia);
app.get('/api/admin/kpis', admin.getKpis);
app.get('/api/admin/respaldo-sql', admin.getRespaldoSql);
app.get('/api/admin/reportes/:tipo', admin.getReporte);
app.get('/api/admin/clientes', admin.listClientes);
app.post('/api/admin/clientes', admin.createCliente);
app.put('/api/admin/clientes/:id', admin.updateCliente);
app.put('/api/admin/clientes/:id/cobrador', admin.asignarClienteCobrador);
app.get('/api/admin/secuencia-cliente', admin.getSecuenciaCliente);
app.get('/api/admin/cobradores', admin.listCobradores);
app.post('/api/admin/cobradores', admin.createCobrador);
app.put('/api/admin/cobradores/:id', admin.updateCobrador);
app.post('/api/admin/cobradores/:id/reset-password', admin.resetPasswordUsuario);
app.get('/api/admin/permisos', admin.getPermisos);
app.put('/api/admin/permisos', admin.setPermisos);
app.get('/api/admin/parametros-financieros', admin.getParametrosFinancieros);
app.put('/api/admin/parametros-financieros', admin.setParametrosFinancieros);
app.get('/api/admin/contadores', admin.listContadores);
app.post('/api/admin/contadores', admin.createContador);
app.put('/api/admin/contadores/:id', admin.updateContador);
app.post('/api/admin/contadores/:id/reset-password', admin.resetPasswordUsuario);
app.post('/api/admin/usuarios/:id/reset-password', admin.resetPasswordUsuario);
app.post('/api/admin/prorrogas', admin.aplicarProrroga);
app.post('/api/admin/prestamos/:id/castigo-perdida', admin.castigarPerdida);
app.get('/api/admin/export/cartera-importacion', admin.exportCarteraImportacion);
app.get('/api/admin/prestamos', admin.listPrestamosActivos);
app.put('/api/admin/prestamos/:id/frecuencia', admin.updatePrestamoFrecuencia);
app.patch('/api/admin/prestamos/:id/recibo-fisico', admin.patchReciboFisicoPrestamo);
app.put('/api/admin/prestamos/:id/recibo-fisico', admin.patchReciboFisicoPrestamo);
app.post('/api/admin/prestamos', admin.crearPrestamo);
app.post('/api/admin/renovaciones', admin.renovacion);
app.get('/api/admin/pagos', admin.listPagosDelDia);
app.get('/api/admin/pagos/detalle', admin.listPagosDetalle);
app.get('/api/admin/clientes/:id/estado-cuenta', admin.getEstadoCuentaCliente);
app.put('/api/admin/pagos/:id', admin.updatePago);
app.get('/api/admin/solicitudes-correccion', admin.listSolicitudesCorreccion);
app.get('/api/admin/rutas', admin.listRutas);
app.post('/api/admin/rutas', admin.crearRuta);
app.post('/api/admin/rutas/sync-cobradores', admin.syncRutasCobradores);
app.put('/api/admin/rutas/:rutaId/optimizar', admin.optimizarRuta);
app.post('/api/admin/demo-clientes-esteli', admin.seedDemoEsteli);
app.post('/api/admin/carga-masiva/validar', admin.validarCargaMasiva);
app.post('/api/admin/carga-masiva/importar', admin.importarCargaMasiva);
app.post('/api/admin/carga-masiva-garantias/validar', admin.validarCargaMasivaGarantias);
app.post('/api/admin/carga-masiva-garantias/importar', admin.importarCargaMasivaGarantias);
app.get('/api/admin/prestamos/:id/garantias', admin.listGarantiasPrestamo);
app.post('/api/admin/prestamos/:id/garantias', admin.agregarGarantiasPrestamo);
app.put('/api/admin/rutas/:rutaId/cobrador', admin.asignarCobrador);
app.post('/api/admin/rutas/:rutaId/clientes', admin.agregarClienteRuta);

app.get('/api/admin/campo/agenda', adminCampo.getAgendaCampo);
app.get('/api/admin/campo/mi-ruta', adminCampo.getMiRutaCampo);
app.post('/api/admin/campo/mi-ruta/clientes', adminCampo.postClienteMiRutaCampo);
app.delete('/api/admin/campo/mi-ruta/clientes/:clienteId', adminCampo.deleteClienteMiRutaCampo);
app.put('/api/admin/campo/mi-ruta/optimizar', adminCampo.putOptimizarMiRutaCampo);
app.get('/api/admin/campo/resumen-cobro/:prestamoId', adminCampo.getResumenCobroCampo);
app.post('/api/admin/campo/pago', adminCampo.postPagoCampo);
app.post('/api/admin/campo/gestion-no-pago', adminCampo.postGestionNoPagoCampo);

app.get('/api/cobrador/pagos/:cobradorId', cobrador.pagosPorFecha);
app.get('/api/cobrador/prestamos/:cobradorId', cobrador.listPrestamosCobrador);
app.post('/api/cobrador/prorrogas/:cobradorId', cobrador.aplicarProrrogaCobrador);
app.get('/api/cobrador/ruta-diaria/:cobradorId', cobrador.rutaDiaria);
app.get('/api/cobrador/cierre-hoy/:cobradorId', cobrador.cierreHoy);
app.get('/api/cobrador/cierre-caja/:cobradorId/resumen', cobrador.resumenCierreCaja);
app.post('/api/cobrador/cierre-caja/:cobradorId', cobrador.registrarCierreCaja);
app.post('/api/cobrador/sync/push', cobrador.pushSync);
app.get('/api/cobrador/sync/aviso/:cobradorId', cobrador.syncAviso);
app.get('/api/cobrador/correcciones/:cobradorId', cobrador.getCorreccionesAdmin);
app.post('/api/cobrador/solicitud-correccion', cobrador.crearSolicitudCorreccion);

app.post('/api/pagos/sync-masivo', syncMasivo);
app.get('/api/sync/pull', pullChanges);
app.post('/api/sync/push-gestiones', pushGestiones);

module.exports = app;
