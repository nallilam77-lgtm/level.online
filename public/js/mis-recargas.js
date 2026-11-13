// =========================================================================
// MIS RECARGAS (todas las tiendas): historial en ESTE equipo (localStorage), sin cuentas ni servidor.
//   - "Repetir": deja la misma cuenta y el mismo paquete elegidos (el cliente solo paga).
//   - "Comprobante": imagen con el pedido para guardar o compartir (se arma en el teléfono).
//   - Tiendas manuales: el estado del pedido (Recibido → En proceso → Entregado) se consulta solo cada
//     30 s mientras la página está abierta (/api/juego?accion=estado, por idPedido).
// Uso en la página:
//   MisRecargas.iniciar({ juego: 'freefire', nombreJuego: 'Free Fire', repetir: async (r) => { ... } })
//   MisRecargas.guardar({ paquete, cuenta, idJugador, zona, precio, referencia, txn, codigo, idPedido, estado, repetible })
//   <button data-comprobante-ultimo> en la ventana de éxito: comprobante de la última recarga
// Nunca se guardan contraseñas ni correos. El código de Roblox se guarda (es del cliente) pero NUNCA va en
// el comprobante, que se comparte.
// =========================================================================
(function () {
  const CLAVE = 'levelup_mis_recargas';
  const MAX_POR_JUEGO = 10;
  const SEGUIMIENTO_MS = 30000;
  // Pedidos manuales más viejos que esto ya no se consultan
  const SEGUIMIENTO_MAX_MS = 72 * 60 * 60 * 1000;
  const ESTADOS = {
    entregada: { texto: 'Entregada', clase: 'ok' },
    completado: { texto: 'Entregada', clase: 'ok' },
    pendiente: { texto: 'Recibido', clase: 'espera' },
    en_proceso: { texto: 'En proceso', clase: 'espera' },
    en_revision: { texto: 'En revisión', clase: 'alerta' },
    incompleto: { texto: 'Pago incompleto', clase: 'alerta' },
    problema: { texto: 'Escríbenos', clase: 'error' },
  };
  const SIGUE_ABIERTO = ['pendiente', 'en_proceso', 'incompleto'];
  let config = null;
  let abierto = false;

  const escapar = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const textoBs = (p) => {
    if (p === undefined || p === null || p === '') return '';
    // Espacio que no se corta: "98,80 Bs" nunca queda partido en dos líneas
    if (typeof p === 'number') return `${p.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs`;
    return /bs$/i.test(String(p).trim()) ? String(p).trim() : `${String(p).trim()} Bs`;
  };
  const fechaCorta = (ms) => new Date(ms).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function leerTodo() {
    try {
      const datos = JSON.parse(localStorage.getItem(CLAVE) || '[]');
      return Array.isArray(datos) ? datos.filter((r) => r && typeof r === 'object' && typeof r.juego === 'string') : [];
    } catch (e) { return []; }
  }
  function escribirTodo(lista) {
    try { localStorage.setItem(CLAVE, JSON.stringify(lista)); } catch (e) { /* sin almacenamiento: no se recuerda */ }
  }
  const delJuego = () => (config ? leerTodo().filter((r) => r.juego === config.juego).sort((a, b) => b.fecha - a.fecha) : []);

  function guardar(datos) {
    if (!config || !datos || !datos.paquete) return null;
    const recarga = {
      clave: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      juego: config.juego, nombreJuego: config.nombreJuego, fecha: Date.now(),
      paquete: String(datos.paquete).slice(0, 80), cuenta: String(datos.cuenta || '').slice(0, 80),
      idJugador: String(datos.idJugador || '').slice(0, 30), zona: String(datos.zona || '').slice(0, 8),
      precio: datos.precio ?? '', referencia: String(datos.referencia || '').slice(0, 12),
      txn: String(datos.txn || '').slice(0, 20), codigo: String(datos.codigo || '').slice(0, 60),
      idPedido: String(datos.idPedido || '').slice(0, 64), estado: ESTADOS[datos.estado] ? datos.estado : 'entregada',
      // false: no se sabe la cuenta (p. ej. pago completado desde el aviso): sin botón "Repetir"
      repetible: datos.repetible !== false,
    };
    const otros = leerTodo().filter((r) => r.juego !== config.juego);
    escribirTodo([...otros, recarga, ...delJuego()].slice(0, otros.length + MAX_POR_JUEGO));
    pintar();
    if (recarga.idPedido) seguir();
    return recarga;
  }

  function actualizar(clave, cambios) {
    const lista = leerTodo();
    const r = lista.find((x) => x.clave === clave);
    if (!r) return;
    Object.assign(r, cambios);
    escribirTodo(lista);
  }

  // ---------- Panel ----------
  function pintar() {
    if (!config) return;
    const lista = delJuego();
    let panel = document.getElementById('misRecargas');
    if (!lista.length) { panel?.remove(); return; }
    if (!panel) {
      panel = document.createElement('details');
      panel.id = 'misRecargas';
      panel.className = 'mis-recargas';
      panel.addEventListener('toggle', () => { abierto = panel.open; });
      const ancla = document.getElementById('avisoPagoPendiente') || document.querySelector('.juego-hero');
      if (ancla) ancla.after(panel); else document.body.prepend(panel);
    }
    panel.open = abierto;
    panel.innerHTML = `
      <summary class="mis-recargas__titulo">
        <span class="mis-recargas__icono" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span>Mis recargas <small>(${lista.length})</small></span>
        <span class="mis-recargas__flecha" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </summary>
      <ul class="mis-recargas__lista">${lista.map(fila).join('')}</ul>
      <p class="mis-recargas__nota">Solo se guardan en este teléfono.</p>`;
    panel.querySelectorAll('[data-accion]').forEach((boton) => boton.addEventListener('click', () => accion(boton)));
  }

  function fila(r) {
    const estado = ESTADOS[r.estado] || ESTADOS.entregada;
    const detalle = [r.cuenta, textoBs(r.precio), fechaCorta(r.fecha)].filter(Boolean).map(escapar).join(' · ');
    const puedeRepetir = config.repetir && r.repetible !== false;
    return `
      <li class="mis-recargas__fila">
        <div class="mis-recargas__info">
          <strong>${escapar(r.paquete)}</strong>
          <span>${detalle}</span>
          ${r.codigo ? `<span class="mis-recargas__codigo">Código: <b>${escapar(r.codigo)}</b></span>` : ''}
        </div>
        <span class="mis-recargas__estado mis-recargas__estado--${estado.clase}">${estado.texto}</span>
        <div class="mis-recargas__acciones">
          ${puedeRepetir ? `<button type="button" class="mis-recargas__btn mis-recargas__btn--principal" data-accion="repetir" data-clave="${escapar(r.clave)}">Repetir</button>` : ''}
          <button type="button" class="mis-recargas__btn" data-accion="comprobante" data-clave="${escapar(r.clave)}">Comprobante</button>
          ${r.codigo ? `<button type="button" class="mis-recargas__btn" data-accion="copiar" data-clave="${escapar(r.clave)}">Copiar código</button>` : ''}
        </div>
      </li>`;
  }

  async function accion(boton) {
    const r = delJuego().find((x) => x.clave === boton.dataset.clave);
    if (!r) return;
    if (boton.dataset.accion === 'comprobante') return comprobante(r);
    if (boton.dataset.accion === 'copiar') {
      navigator.clipboard?.writeText(r.codigo).then(() => aviso('✅ Código copiado')).catch(() => {});
      return;
    }
    if (boton.dataset.accion === 'repetir' && config.repetir) {
      abierto = false;
      document.getElementById('misRecargas').open = false;
      boton.disabled = true;
      try { await config.repetir(r); } finally { boton.disabled = false; }
    }
  }

  // Burbuja de la página (#toastBubble existe en todas las tiendas)
  function aviso(texto) {
    const burbuja = document.getElementById('toastBubble');
    if (!burbuja) return;
    burbuja.textContent = texto;
    burbuja.classList.add('show');
    clearTimeout(aviso.t);
    aviso.t = setTimeout(() => burbuja.classList.remove('show'), 4000);
  }

  // Espera a que la página termine de dibujar el catálogo (para "Repetir" apenas abre)
  async function esperarCatalogo(ms = 10000) {
    const fin = Date.now() + ms;
    while (!(window.catalogoGlobal && window.catalogoGlobal.length) && Date.now() < fin) await new Promise((r) => setTimeout(r, 250));
  }

  // ---------- Comprobante (imagen) ----------
  function cargarImagen(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function comprobante(r) {
    const css = getComputedStyle(document.documentElement);
    const color = (nombre, respaldo) => (css.getPropertyValue(nombre).trim() || respaldo);
    const acento = color('--game-accent', '#22d3ee');
    const textoAcento = color('--game-text', acento);
    const fondo = color('--bg-deep', '#0b1120');
    const fondo2 = color('--bg-base', '#0f172a');
    const texto = color('--text-main', '#f1f5f9');
    const tenue = color('--text-muted', '#94a3b8');
    const exito = color('--success', '#22c55e');

    const ancho = 720, alto = 980;
    const lienzo = document.createElement('canvas');
    lienzo.width = ancho; lienzo.height = alto;
    const c = lienzo.getContext('2d');
    const degradado = c.createLinearGradient(0, 0, 0, alto);
    degradado.addColorStop(0, fondo2);
    degradado.addColorStop(1, fondo);
    c.fillStyle = degradado;
    c.fillRect(0, 0, ancho, alto);
    c.fillStyle = acento;
    c.fillRect(0, 0, ancho, 10);

    const logo = await cargarImagen('/logo.png');
    if (logo) c.drawImage(logo, ancho / 2 - 60, 50, 120, 120 * (logo.height / logo.width));

    c.textAlign = 'center';
    c.fillStyle = texto;
    c.font = '900 40px Montserrat, sans-serif';
    c.fillText('COMPROBANTE DE RECARGA', ancho / 2, 230);
    c.fillStyle = textoAcento;
    c.font = '800 28px Montserrat, sans-serif';
    c.fillText(r.nombreJuego || config.nombreJuego, ancho / 2, 275);

    const estado = ESTADOS[r.estado] || ESTADOS.entregada;
    c.fillStyle = estado.clase === 'ok' ? exito : textoAcento;
    c.font = '800 24px Montserrat, sans-serif';
    c.fillText(`● ${estado.texto.toUpperCase()}`, ancho / 2, 320);

    const filas = [
      ['Paquete', r.paquete],
      ['Cuenta', r.cuenta],
      ['Monto', textoBs(r.precio)],
      ['Referencia', r.referencia ? `…${r.referencia}` : ''],
      ['Operación', r.txn],
      ['Fecha', fechaCorta(r.fecha)],
    ].filter(([, v]) => v);
    let y = 390;
    c.textAlign = 'left';
    filas.forEach(([etiqueta, valor]) => {
      c.fillStyle = tenue;
      c.font = '600 22px Montserrat, sans-serif';
      c.fillText(etiqueta, 60, y);
      c.fillStyle = texto;
      c.font = '800 26px Montserrat, sans-serif';
      c.textAlign = 'right';
      let v = String(valor);
      while (c.measureText(v).width > 440 && v.length > 4) v = `${v.slice(0, -2)}…`;
      c.fillText(v, ancho - 60, y);
      c.textAlign = 'left';
      c.strokeStyle = 'rgba(148, 163, 184, 0.18)';
      c.beginPath(); c.moveTo(60, y + 24); c.lineTo(ancho - 60, y + 24); c.stroke();
      y += 78;
    });

    c.textAlign = 'center';
    c.fillStyle = tenue;
    c.font = '600 20px Montserrat, sans-serif';
    c.fillText('Gracias por recargar con Level Up', ancho / 2, alto - 90);
    c.fillStyle = textoAcento;
    c.font = '800 24px Montserrat, sans-serif';
    c.fillText('levelupstore.online', ancho / 2, alto - 52);

    const blob = await new Promise((resolve) => lienzo.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const nombre = `levelup-${r.juego}-${new Date(r.fecha).toISOString().slice(0, 10)}.png`;
    const archivo = new File([blob], nombre, { type: 'image/png' });
    // En el teléfono: el menú de compartir (Galería, WhatsApp...); si no hay, se descarga
    try {
      if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
        await navigator.share({ files: [archivo], title: 'Comprobante Level Up' });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url; enlace.download = nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    aviso('🧾 Comprobante guardado');
  }

  // ---------- Seguimiento de pedidos manuales ----------
  let temporizador = null;
  async function revisarEstados() {
    if (!config || document.visibilityState === 'hidden') return;
    const pendientes = delJuego().filter((r) => r.idPedido && SIGUE_ABIERTO.includes(r.estado) && Date.now() - r.fecha < SEGUIMIENTO_MAX_MS);
    if (!pendientes.length) { clearInterval(temporizador); temporizador = null; return; }
    for (const r of pendientes) {
      try {
        const res = await fetch(`/api/juego?juego=${encodeURIComponent(config.juego)}&accion=estado`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idPedido: r.idPedido }),
        });
        const data = await res.json();
        if (data.status !== 'success' || !ESTADOS[data.estado] || data.estado === r.estado) continue;
        actualizar(r.clave, { estado: data.estado });
        if (data.estado === 'completado') aviso(`✅ ¡Tu recarga de ${r.paquete} está lista!`);
        else if (data.estado === 'en_proceso') aviso(`🔄 Estamos haciendo tu recarga de ${r.paquete}`);
        pintar();
      } catch (e) { /* sin conexión: se intenta en la próxima vuelta */ }
    }
  }
  // Revisa ya y luego cada 30 s (revisarEstados apaga el temporizador cuando no queda nada abierto)
  function seguir() {
    if (!temporizador) temporizador = setInterval(revisarEstados, SEGUIMIENTO_MS);
    revisarEstados();
  }

  function iniciar(opciones) {
    config = opciones;
    const arrancar = () => {
      pintar();
      seguir();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && temporizador) revisarEstados(); });
      document.querySelectorAll('[data-comprobante-ultimo]').forEach((boton) => boton.addEventListener('click', () => {
        const ultima = delJuego()[0];
        if (ultima) comprobante(ultima);
      }));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar); else arrancar();
  }

  window.MisRecargas = { iniciar, guardar, esperarCatalogo, comprobante };
})();
