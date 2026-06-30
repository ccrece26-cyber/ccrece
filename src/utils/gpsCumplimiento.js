const RADIO_METROS_DEFAULT = 200;

function coordsValidas(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  if (Math.abs(la) < 0.0001 && Math.abs(lo) < 0.0001) return false;
  return true;
}

/** Puntos de referencia del cliente (cobro y domicilio pueden ser distintos). */
function refsCliente(cliente) {
  const refs = [];
  if (coordsValidas(cliente?.latitud_cobro, cliente?.longitud_cobro)) {
    refs.push({
      lat: Number(cliente.latitud_cobro),
      lng: Number(cliente.longitud_cobro),
      tipo: 'cobro',
    });
  }
  if (coordsValidas(cliente?.latitud, cliente?.longitud)) {
    const lat = Number(cliente.latitud);
    const lng = Number(cliente.longitud);
    const dup = refs.some((r) => r.lat === lat && r.lng === lng);
    if (!dup) refs.push({ lat, lng, tipo: 'domicilio' });
  }
  return refs;
}

function refCoordsCliente(cliente) {
  const refs = refsCliente(cliente);
  return refs[0] || null;
}

function haversineMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanciaAMejorRef(visitLat, visitLng, refs) {
  let minDist = Infinity;
  let mejorRef = null;
  for (const r of refs) {
    const d = haversineMetros(Number(visitLat), Number(visitLng), r.lat, r.lng);
    if (d < minDist) {
      minDist = d;
      mejorRef = r;
    }
  }
  return { dist: minDist, ref: mejorRef };
}

function analizarVisitaGps(cliente, { pago = null, gestion = null, estadoVisita = null, tipoVisita = null } = {}) {
  const refs = refsCliente(cliente);
  const refPrincipal = refs[0] || null;
  const esCobro =
    estadoVisita === 'cobrado' ||
    estadoVisita === 'cobrado_admin' ||
    tipoVisita === 'liquidado' ||
    tipoVisita === 'cobrado';
  const esNoPago = estadoVisita === 'no_pago';

  let visitLat;
  let visitLng;
  if (pago && esCobro) {
    visitLat = pago.latitud;
    visitLng = pago.longitud;
  } else if (gestion && esNoPago) {
    visitLat = gestion.latitud;
    visitLng = gestion.longitud;
  } else {
    return {
      gps_estado: 'pendiente',
      cumple_gps: null,
      distancia_metros: null,
      ref_gps_tipo: refPrincipal?.tipo || null,
      visita_lat: null,
      visita_lng: null,
      ref_lat: refPrincipal?.lat ?? null,
      ref_lng: refPrincipal?.lng ?? null,
    };
  }

  if (!coordsValidas(visitLat, visitLng)) {
    return {
      gps_estado: 'sin_gps_visita',
      cumple_gps: false,
      distancia_metros: null,
      ref_gps_tipo: refPrincipal?.tipo || null,
      visita_lat: null,
      visita_lng: null,
      ref_lat: refPrincipal?.lat ?? null,
      ref_lng: refPrincipal?.lng ?? null,
    };
  }
  if (!refs.length) {
    return {
      gps_estado: 'sin_ref_cliente',
      cumple_gps: null,
      distancia_metros: null,
      ref_gps_tipo: null,
      visita_lat: Number(visitLat),
      visita_lng: Number(visitLng),
      ref_lat: null,
      ref_lng: null,
    };
  }

  const { dist, ref } = distanciaAMejorRef(visitLat, visitLng, refs);
  const enRango = dist <= RADIO_METROS_DEFAULT;

  return {
    gps_estado: enRango ? 'en_rango' : 'fuera_rango',
    cumple_gps: enRango,
    distancia_metros: Math.round(dist),
    ref_gps_tipo: ref?.tipo || null,
    visita_lat: Number(visitLat),
    visita_lng: Number(visitLng),
    ref_lat: ref?.lat ?? null,
    ref_lng: ref?.lng ?? null,
  };
}

function resumenGpsAgenda(agenda = []) {
  const visitadas = agenda.filter(
    (v) =>
      v.estado_visita === 'cobrado' ||
      v.estado_visita === 'cobrado_admin' ||
      v.estado_visita === 'no_pago' ||
      v.tipo_visita === 'liquidado'
  );
  const conGps = visitadas.filter((v) => v.cumple_gps === true || v.cumple_gps === false);
  const enRango = visitadas.filter((v) => v.cumple_gps === true).length;
  const fuera = visitadas.filter((v) => v.gps_estado === 'fuera_rango').length;
  const sinGps = visitadas.filter((v) => v.gps_estado === 'sin_gps_visita').length;
  const sinRef = visitadas.filter((v) => v.gps_estado === 'sin_ref_cliente').length;
  return {
    visitas_con_evento: visitadas.length,
    verificables_gps: conGps.length,
    en_rango: enRango,
    fuera_rango: fuera,
    sin_gps_visita: sinGps,
    sin_ref_cliente: sinRef,
    porcentaje_gps:
      conGps.length > 0 ? Math.round((enRango / conGps.length) * 100) : null,
  };
}

module.exports = {
  RADIO_METROS_DEFAULT,
  analizarVisitaGps,
  resumenGpsAgenda,
  refCoordsCliente,
  refsCliente,
};
