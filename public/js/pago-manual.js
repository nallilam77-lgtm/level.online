// =========================================================================
// PAGO VERIFICADO A MANO (las 7 tiendas). Cuando la notificación del banco no llegó y el administrador
// tiene encendido "Verificar a mano los pagos que no lleguen" (api/_lib/pagos-manual.js), /api/recargar
// responde con { solicitudPago: <id> } en vez de "referencia no encontrada": el pedido ya quedó guardado
// como "Recibido" y, cuando el administrador apruebe el pago, la recarga la hace el servidor solo.
// Este archivo envuelve fetch SOLO para /api/recargar y, en ese caso, muestra "Estamos verificando tu pago"
// con dónde ver el estado del pedido (Consulta tus últimas recargas con su ID, o su perfil). El cliente puede
// cerrar la página. Mientras la ventana está abierta, el estado se pone al día cada 8 s
// (/api/juego?accion=solicitud_estado). "Entendido" recarga la página (la tienda queda limpia).
// A la tienda nunca le llega esa respuesta: no muestra su error ni cuenta un intento fallido.
// Estilos en css/pago-manual.css (usa los --game-* de cada tienda). Va en el <head> con defer.
// =========================================================================
(function () {
  const fetchOriginal = window.fetch.bind(window);
  const CSS = '/css/pago-manual.css?v=2';
  const CADA_MS = 8000;
  const WHATSAPP = 'https://wa.me/584141916377?text=';

  const esRecarga = (entrada) => /\/api\/recargar(\?|$)/.test(typeof entrada === 'string' ? entrada : (entrada && entrada.url) || '');

  function datosDe(init) {
    try {
      const b = JSON.parse(init && init.body) || {};
      return { ultimos5: String(b.referencia || '').replace(/\D/g, '').slice(-5), id: String(b.id || b.user || '').trim().slice(0, 40) };
    } catch (e) { return { ultimos5: '', id: '' }; }
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

  function ventana(idSolicitud, { ultimos5, id }) {
    cargarCss();
    const conSesion = !!(window.Sesion && typeof Sesion.hay === 'function' && Sesion.hay());
    const fondo = crear('div', 'pago-manual-fondo');
    const caja = crear('div', 'pago-manual');
    caja.setAttribute('role', 'dialog');
    caja.setAttribute('aria-modal', 'true');
    caja.setAttribute('aria-labelledby', 'pagoManualTitulo');
    const icono = crear('div', 'pago-manual-giro');
    icono.setAttribute('aria-hidden', 'true');
    const titulo = crear('h2', 'pago-manual-titulo', 'Estamos verificando tu pago');
    titulo.id = 'pagoManualTitulo';
    const texto = crear('p', 'pago-manual-texto',
      `Recibimos tu pedido${ultimos5 ? ` (referencia …${ultimos5})` : ''}. La notificación de tu banco todavía no nos llega y nuestro equipo lo está revisando. Apenas lo confirmemos, tu recarga se hace sola: no tienes que pagar de nuevo ni quedarte en esta página.`);
    const estado = crear('p', 'pago-manual-estado', '🕐 Estado: pago en verificación');
    estado.setAttribute('role', 'status');

    // Dónde ver el estado
    const donde = crear('div', 'pago-manual-donde');
    donde.append(crear('p', 'pago-manual-donde-titulo', '¿Dónde veo cómo va mi pedido?'));
    const lista = crear('ul', 'pago-manual-lista');
    const paso1 = crear('li');
    paso1.append('En el inicio de ', crear('strong', '', 'levelupstore.online'), ', en ', crear('strong', '', '"Consulta tus últimas recargas"'),
      id ? `, con tu ID ${id}.` : ', con tu ID de jugador.');
    lista.append(paso1);
    if (conSesion) {
      const paso2 = crear('li');
      paso2.append('En ', crear('strong', '', 'tu perfil'), ': sale en tus recargas y cambia solo.');
      lista.append(paso2);
    }
    donde.append(lista);

    const acciones = crear('div', 'pago-manual-acciones');
    const ver = crear('a', 'pago-manual-ver', 'Ver el estado de mi pedido');
    ver.href = id ? `/?consulta=${encodeURIComponent(id)}#consulta` : '/#consulta';
    const wa = crear('a', 'pago-manual-cancelar', 'Escribir por WhatsApp');
    wa.href = WHATSAPP + encodeURIComponent(`Hola Level Up, hice un pago${ultimos5 ? ` con referencia terminada en ${ultimos5}` : ''}${id ? ` para el ID ${id}` : ''} y está en verificación.`);
    wa.target = '_blank'; wa.rel = 'noopener';
    const listo = crear('button', 'pago-manual-cancelar', 'Entendido');
    listo.type = 'button';
    listo.addEventListener('click', () => location.reload());
    acciones.append(ver, wa, listo);

    caja.append(icono, titulo, texto, estado, donde, acciones);
    fondo.append(caja);
    document.body.classList.add('modal-abierto');
    document.body.append(fondo);
    ver.focus();

    // Mientras la ventana está abierta, el estado se pone al día solo
    const reloj = setInterval(async () => {
      if (!document.body.contains(fondo) || document.visibilityState !== 'visible') return;
      try {
        const d = await (await fetchOriginal(`/api/juego?accion=solicitud_estado&id=${encodeURIComponent(idSolicitud)}`, { cache: 'no-store' })).json();
        if (d.estado === 'aprobado') {
          clearInterval(reloj);
          icono.className = 'pago-manual-ok';
          titulo.textContent = '¡Pago confirmado!';
          estado.textContent = '✅ Tu pago fue confirmado y tu recarga ya se está haciendo. Mira el estado de tu pedido para ver cuándo se entrega.';
        } else if (d.estado === 'rechazado') {
          clearInterval(reloj);
          icono.className = 'pago-manual-error';
          titulo.textContent = 'No pudimos confirmar tu pago';
          estado.textContent = '❌ Revisa la referencia o escríbenos por WhatsApp con tu comprobante.';
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
