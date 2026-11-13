// =========================================================================
// PREMIO DE CLIENTE FIEL (Free Fire, Blood Strike, Mobile Legends y Roblox)
// La 6.ª recarga de la misma cuenta (ID) lleva 1,5 % de descuento, y así cada 6 (12.ª, 18.ª...).
// El servidor decide todo (api/_lib/fidelidad.js): aquí solo se pregunta al confirmar la cuenta, se
// muestra el avance o el premio y, con premio, se dibuja el catálogo con los precios que devolvió.
// No se suma a un código de descuento: con código aplicado, el premio queda para la próxima recarga.
// Uso en la página:
//   Fidelidad.iniciar({ juego: 'freefire', codigoActivo: () => !!descuento.codigo(),
//                       dibujar: (catalogoConPremio | null) => ... })
//   Fidelidad.consultar({ id, zona })   // al confirmar la cuenta
//   Fidelidad.limpiar()                 // al cambiar la cuenta
//   Fidelidad.catalogo()                // catálogo con el premio (o null)
//   Fidelidad.firma()                   // va en la recarga como premioFidelidad
//   Fidelidad.mostrar()                 // repinta el aviso (al aplicar o quitar un código)
// Necesita #idStatus en la página (el aviso va justo debajo). Estilos en css/fidelidad.css.
// =========================================================================
(function () {
  let config = null;
  let estado = null;
  let consulta = 0;

  const ICONO_REGALO = '<span class="fidelidad__icono" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  const porcentajeTexto = (p) => `${Number(p).toLocaleString('es-VE', { maximumFractionDigits: 1 })} %`;

  function caja() {
    let el = document.getElementById('fidelidadEstado');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fidelidadEstado';
      el.className = 'fidelidad';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      const ancla = document.getElementById('idStatus');
      if (ancla) ancla.after(el); else return null;
    }
    return el;
  }

  function mostrar() {
    const el = caja();
    if (!el) return;
    if (!estado || !estado.activo) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const conCodigo = config.codigoActivo && config.codigoActivo();
    if (estado.premio > 0) {
      el.className = 'fidelidad fidelidad--premio';
      el.innerHTML = conCodigo
        ? `${ICONO_REGALO}<span>Tienes <strong>${porcentajeTexto(estado.premio)} de premio</strong> por cliente fiel. No se suma al código: queda guardado para tu próxima recarga sin código.</span>`
        : `${ICONO_REGALO}<span><strong>¡Premio de cliente fiel!</strong> Esta recarga tiene <strong>${porcentajeTexto(estado.premio)} de descuento</strong>. Los precios de abajo ya lo incluyen.</span>`;
      return;
    }
    const cada = Number(estado.cada) || 6;
    const hechas = Math.max(0, cada - 1 - (Number(estado.faltan) || 0));
    const puntos = Array.from({ length: cada }, (_, i) => `<span class="fidelidad__punto${i < hechas ? ' fidelidad__punto--lleno' : ''}${i === cada - 1 ? ' fidelidad__punto--premio' : ''}"></span>`).join('');
    el.className = 'fidelidad';
    el.innerHTML = `<span class="fidelidad__puntos" aria-hidden="true">${puntos}</span><span>Cliente fiel: llevas <strong>${hechas} de ${cada - 1}</strong> recargas. La n.º ${cada} lleva <strong>1,5 % de descuento</strong>.</span>`;
  }

  async function consultar(cuenta) {
    if (!config) return;
    const numero = ++consulta;
    try {
      const res = await fetch(`/api/juego?juego=${encodeURIComponent(config.juego)}&accion=fidelidad`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuenta),
      });
      const data = await res.json();
      // El cliente cambió de cuenta mientras se consultaba: esta respuesta ya no sirve
      if (numero !== consulta) return;
      estado = data && data.status === 'success' && data.activo ? data : null;
    } catch (e) {
      if (numero !== consulta) return;
      estado = null;
    }
    mostrar();
    if (estado && estado.premio > 0 && Array.isArray(estado.catalogo) && !(config.codigoActivo && config.codigoActivo())) {
      config.dibujar(estado.catalogo);
    }
  }

  function limpiar() {
    consulta++;
    const teniaCatalogo = !!(estado && estado.catalogo);
    estado = null;
    mostrar();
    if (teniaCatalogo && config && !(config.codigoActivo && config.codigoActivo())) config.dibujar(null);
  }

  window.Fidelidad = {
    iniciar: (opciones) => { config = opciones; },
    consultar,
    limpiar,
    mostrar,
    catalogo: () => (estado && estado.premio > 0 && Array.isArray(estado.catalogo) ? estado.catalogo : null),
    firma: () => (estado && estado.premio > 0 && estado.firma) || '',
  };
})();
