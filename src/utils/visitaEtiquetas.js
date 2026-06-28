function etiquetaVisitaDesdePago(pg, esLiquidacion = false) {
  const porAdmin = pg && Number(pg.registrado_por_admin) === 1;
  if (esLiquidacion && porAdmin) return 'Liquidación por administrador';
  if (esLiquidacion) return 'Liquidación anticipada';
  if (porAdmin) return 'Cobrado por administrador';
  return null;
}

module.exports = { etiquetaVisitaDesdePago };
