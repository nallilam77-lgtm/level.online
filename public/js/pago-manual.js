// =========================================================================
// PAGO VERIFICADO A MANO (las 7 tiendas). Cuando la notificación del banco no llegó ("Revisar pagos",
// api/_lib/pagos-manual.js), /api/recargar responde con { solicitudPago: <id> } en vez de "referencia no
// encontrada": el pedido ya quedó guardado ("Verificando pago") y, cuando el administrador suelte el pago,
// la recarga la hace el servidor solo.
// Este archivo envuelve fetch SOLO para /api/recargar y, en ese caso, muestra una ventana con el resumen del
// pedido y tres pasos (Pedido recibido → Verificando pago → Recarga en camino) que avanzan solos mientras
// está abierta (cada 8 s, /api/juego?accion=solicitud_estado; rechazado → el motivo que escribió el
// administrador). El cliente puede cerrarla: "Ver el estado de mi pedido" lleva a la consulta del inicio
// con su ID y "Entendido" recarga la página (la tienda queda limpia).
// A la tienda nunca le llega esa respuesta: no muestra su error ni cuenta un intento fallido.
// Estilos en css/pago-manual.css (usa los --game-* de cada tienda). Va en el <head> con defer.
// =========================================================================
(function () {
  const fetchOriginal = window.fetch.bind(window);
  const CSS = '/css/pago-manual.css?v=4';
  const CADA_MS = 8000;
  const WHATSAPP = 'https://wa.me/584141916377?text=';
  const SVG = 'http://www.w3.org/2000/svg';
  // Iconos dibujados (nada de emojis como icono principal: .claude/UI_RULES.md)
  const ICONOS = {
    reloj: 'M12 7v5l3 2 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
    listo: 'M5 12.5l4.5 4.5L19 7.5',
    error: 'M7 7l10 10 M17 7L7 17',
    rayo: 'M13 3L5 14h6l-1 7 8-11h-6l1-7z',
    whatsapp: 'M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.5 20.5l4.2-1.1A8.5 8.5 0 1 0 12 3.5z M9 8.5c.3 2.7 2.8 5.3 5.5 5.7l1-1.2 1.8.9-.4 1.6c-3.8.4-8-3.8-7.6-7.6l1.6-.4.9 1.8z',
  };

  const esRecarga = (entrada) => /\/api\/recargar(\?|$)/.test(typeof entrada === 'string' ? entrada : (entrada && entrada.url) || '');

  function datosDe(init) {
    try {
      const b = JSON.parse(init && init.body) || {};
      return {
        ultimos5: String(b.referencia || '').replace(/\D/g, '').slice(-5),
        id: String(b.id || b.user || '').trim().slice(0, 40),
        nombreId: b.user && !b.id ? 'Usuario' : 'ID',   // Roblox manda el usuario, no un ID
        paquete: String(b.paquete || b.producto || '').trim().slice(0, 60),
      };
    } catch (e) { return { ultimos5: '', id: '', paquete: '', nombreId: 'ID' }; }
  }

  function cargarCss() {
    if (document.querySelector('link[data-pago-manual]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = CSS; l.dataset.pagoManual = '';
    document.head.appendChild(l);
  }

  const crear = (tag, clase, texto) => {
    const e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto !== undefined) e.textContent = texto;
    return e;
  };
  function icono(nombre, clase) {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    if (clase) s.setAttribute('class', clase);
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', ICONOS[nombre]);
    s.append(p);
    return s;
  }

  function ventana(idSolicitud, { ultimos5, id, paquete, nombreId }) {
    cargarCss();
    const fondo = crear('div', 'vp-fondo');
    const caja = crear('div', 'vp-caja');
    caja.setAttribute('role', 'dialog');
    caja.setAttribute('aria-modal', 'true');
    caja.setAttribute('aria-labelledby', 'vpTitulo');
    caja.setAttribute('aria-describedby', 'vpTexto');
    caja.dataset.estado = 'verificando';

    // Cabecera: icono con anillo del color del juego
    const sello = crear('div', 'vp-sello');
    sello.append(icono('reloj', 'vp-sello-icono'));
    const etiqueta = crear('p', 'vp-etiqueta', 'Pedido recibido');
    const titulo = crear('h2', 'vp-titulo', 'Estamos verificando tu pago');
    titulo.id = 'vpTitulo';
    const texto = crear('p', 'vp-texto', 'Tu banco no nos envió el aviso del pago, así que lo revisamos a mano. Apenas lo confirmemos, tu recarga sale sola.');
    texto.id = 'vpTexto';

    // Resumen del pedido
    const resumen = crear('dl', 'vp-resumen');
    const dato = (nombre, valor) => {
      if (!valor) return;
      const fila = crear('div', 'vp-dato');
      fila.append(crear('dt', '', nombre), crear('dd', '', valor));
      resumen.append(fila);
    };
    dato('Paquete', paquete);
    dato(nombreId || 'ID', id);
    dato('Referencia', ultimos5 ? `…${ultimos5}` : '');

    // Pasos
    const pasos = crear('ol', 'vp-pasos');
    const paso = (nombre, estado) => {
      const li = crear('li', 'vp-paso');
      li.dataset.paso = estado;
      const punto = crear('span', 'vp-punto');
      punto.setAttribute('aria-hidden', 'true');
      li.append(punto, crear('span', 'vp-paso-texto', nombre));
      pasos.append(li);
      return { li, punto };
    };
    const p1 = paso('Pedido recibido', 'listo');
    p1.punto.append(icono('listo'));
    const p2 = paso('Verificando pago', 'activo');
    const p3 = paso('Recarga en camino', 'espera');

    const aviso = crear('p', 'vp-aviso');
    aviso.append(icono('rayo', 'vp-aviso-icono'), crear('span', '', 'No tienes que pagar de nuevo ni quedarte aquí: puedes cerrar esta ventana.'));
    aviso.setAttribute('role', 'status');

    // Acciones
    const acciones = crear('div', 'vp-acciones');
    const ver = crear('a', 'vp-boton vp-boton--principal', 'Ver el estado de mi pedido');
    ver.href = id ? `/?consulta=${encodeURIComponent(id)}#consulta` : '/#consulta';
    const segundarias = crear('div', 'vp-secundarias');
    const wa = crear('a', 'vp-boton vp-boton--borde');
    wa.append(icono('whatsapp', 'vp-boton-icono'), crear('span', '', 'WhatsApp'));
    wa.href = WHATSAPP + encodeURIComponent(`Hola Level Up, hice un pago${ultimos5 ? ` con referencia terminada en ${ultimos5}` : ''}${id ? ` para el ID ${id}` : ''} y está en verificación.`);
    wa.target = '_blank'; wa.rel = 'noopener';
    const listo = crear('button', 'vp-boton vp-boton--borde', 'Entendido');
    listo.type = 'button';
    listo.addEventListener('click', () => location.reload());
    segundarias.append(wa, listo);
    acciones.append(ver, segundarias);
    const pie = crear('p', 'vp-pie', 'También lo ves en "Consulta tus últimas recargas" del inicio y en tu perfil.');

    caja.append(sello, etiqueta, titulo, texto, resumen, pasos, aviso, acciones, pie);
    fondo.append(caja);
    document.body.classList.add('modal-abierto');
    document.body.append(fondo);
    ver.focus();

    const cambiarAviso = (nombre, mensaje) => { aviso.replaceChildren(icono(nombre, 'vp-aviso-icono'), crear('span', '', mensaje)); };

    // Mientras la ventana está abierta, los pasos avanzan solos
    const reloj = setInterval(async () => {
      if (!document.body.contains(fondo) || document.visibilityState !== 'visible') return;
      try {
        const d = await (await fetchOriginal(`/api/juego?accion=solicitud_estado&id=${encodeURIComponent(idSolicitud)}`, { cache: 'no-store' })).json();
        if (d.estado === 'aprobado') {
          clearInterval(reloj);
          caja.dataset.estado = 'aprobado';
          sello.replaceChildren(icono('listo', 'vp-sello-icono'));
          etiqueta.textContent = 'Pago confirmado';
          titulo.textContent = '¡Tu recarga va en camino!';
          texto.textContent = 'Confirmamos tu pago y ya estamos haciendo tu recarga. Mira el estado de tu pedido para ver cuándo se entrega.';
          p2.li.dataset.paso = 'listo'; p2.punto.replaceChildren(icono('listo'));
          p3.li.dataset.paso = 'activo';
          cambiarAviso('rayo', 'Normalmente llega en pocos minutos.');
        } else if (d.estado === 'rechazado') {
          clearInterval(reloj);
          caja.dataset.estado = 'rechazado';
          sello.replaceChildren(icono('error', 'vp-sello-icono'));
          etiqueta.textContent = 'Pago no confirmado';
          titulo.textContent = 'No pudimos confirmar tu pago';
          texto.textContent = 'Si crees que es un error, escríbenos por WhatsApp con tu comprobante y lo revisamos.';
          p2.li.dataset.paso = 'error'; p2.punto.replaceChildren(icono('error'));
          p2.li.querySelector('.vp-paso-texto').textContent = 'Pago rechazado';
          cambiarAviso('error', d.motivo ? `Motivo: ${String(d.motivo).slice(0, 200)}` : 'Revisa la referencia y el monto de tu pago.');
        }
      } catch (e) { /* sin conexión: se vuelve a preguntar */ }
    }, CADA_MS);
  }

  window.fetch = async function (entrada, init) {
    const respuesta = await fetchOriginal(entrada, init);
    // Las tiendas manuales responden los errores con HTTP 200: se mira el cuerpo, no el código
    if (!esRecarga(entrada)) return respuesta;
    let datos;
    try { datos = await respuesta.clone().json(); } catch (e) { return respuesta; }
    if (!datos || datos.status === 'success' || typeof datos.solicitudPago !== 'string') return respuesta;
    ventana(datos.solicitudPago, datosDe(init));
    // La tienda se queda esperando (su pantalla de "procesando" queda detrás): "Entendido" recarga la página
    return new Promise(() => {});
  };
})();
