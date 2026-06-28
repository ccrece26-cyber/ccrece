const RADIO_METROS_DEFAULT = 200;

function coordsValidas(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  if (Math.abs(la) < 0.0001 && Math.abs(lo) < 0.0001) return false;
  return true;
}

function refCoordsCliente(cliente) {
  if (coordsValidas(cliente?.latitud_cobro, cliente?.longitud_cobro)) {
    return { lat: Number(cliente.latitud_cobro), lng: Number(cliente.longitud_cobro), tipo: 'cobro' };
  }
  if (coordsValidas(cliente?.latitud, cliente?.longitud)) {
    return { lat: Number(cliente.latitud), lng: Number(cliente.longitud), tipo: 'domicilio' };
  }
  return null;
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

function analizarVisitaGps(cliente, { pago = null, gestion = null, estadoVisita = null, tipoVisita = null } = {}) {
  const ref = refCoordsCliente(cliente);
  const esCobro =
    estadoVisita === 'cobrado' ||
    estadoVisita === 'cobrado_admin' ||
    tipoVisita === 'liquidado' ||
    tipoVisita === 'cobrado';

  let visitLat;
  let visitLng;
  if (pago && esCobro) {
    visitLat = pago.latitud;
    visitLng = pago.longitud;
  } else if (gestion && estadoVisita === 'no_pago') {
    visitLat = gestion.latitud;
    visitLng = gestion.longitud;
  } else {
    return {
      gps_estado: 'pendiente',
      cumple_gps: null,
      distancia_metros: null,
      ref_gps_tipo: ref?.tipo || null,
      visita_lat: null,
      visita_lng: null,
      ref_lat: ref?.lat ?? null,
      ref_lng: ref?.lng ?? null,
    };
  }

  if (!coordsValidas(visitLat, visitLng)) {
    return {
      gps_estado: 'sin_gps_visita',
      cumple_gps: false,
      distancia_metros: null,
      ref_gps_tipo: ref?.tipo || null,
      visita_lat: null,
      visita_lng: null,
      ref_lat: ref?.lat ?? null,
      ref_lng: ref?.lng ?? null,
    };
  }
  if (!ref) {
    return {
      gps_estado: 'sin_ref_cliente',
      cumple_gps: null,
      distancia_metros: null,
      ref_gps_tipo: null,
      visita_lat: coordsValidas(visitLat, visitLng) ? Number(visitLat) : null,
      visita_lng: coordsValidas(visitLat, visitLng) ? Number(visitLng) : null,
      ref_lat: null,
      ref_lng: null,
    };
  }

  const dist = haversineMetros(Number(visitLat), Number(visitLng), ref.lat, ref.lng);
  const enRango = dist <= RADIO_METROS_DEFAULT;
  return {
    gps_estado: enRango ? 'en_rango' : 'fuera_rango',
    cumple_gps: enRango,
    distancia_metros: Math.round(dist),
    ref_gps_tipo: ref.tipo,
    visita_lat: Number(visitLat),
    visita_lng: Number(visitLng),
    ref_lat: ref.lat,
    ref_lng: ref.lng,
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
};
