// =========================================================================
// PAGO POR COMPLETAR (Free Fire, Blood Strike, Mobile Legends y Roblox)
// Cuando un pago no alcanza, el servidor da una clave para pagar la diferencia (vale 48 h).
// Este archivo:
//   1. La guarda en ESTE equipo (localStorage) junto con el paquete, la cuenta y lo que falta, para
//      que el cliente pueda salir a pagar y, al volver a la tienda, completar con un toque.
//   2. Lee la referencia desde la captura del pago de la diferencia (LectorReferencia, sin subirla).
//   3. Arma el mensaje de WhatsApp con todos los datos del pedido.
// Uso en la página (dentro de su <script type="module">):
//   PagoPendiente.iniciar({ juego: 'freefire', nombreJuego: 'Free Fire', excluir: () => [tel, cedula],
//                           abrir: async (pendiente) => mostrarCompletarPago(pendiente) });
//   PagoPendiente.guardar({ token, faltante, horas, paquete, cuenta, referencia, pagado, precio })
//   PagoPendiente.borrar()
// La clave nunca sale del equipo salvo hacia /api/recargar (como antes); el mensaje de WhatsApp no la lleva.
// =========================================================================
(function () {
  const WHATSAPP_TIENDA = '584141916377';
  const HORAS_POR_DEFECTO = 48;
  let config = null;

  const clave = () => `levelup_por_completar_${config.juego}`;
  const bs = (n) => `${(Number(n) || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs`;
  const escapar = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function leer() {
    if (!config) return null;
    try {
      const p = JSON.parse(localStorage.getItem(clave()) || 'null');
      if (!p || typeof p.token !== 'string' || !(p.vence > Date.now())) {
        localStorage.removeItem(clave());
        return null;
      }
      return p;
    } catch (e) { return null; }
  }

  // Guarda (o actualiza) el pago pendiente. Con la misma clave se conserva el vencimiento original
  // (el servidor no lo renueva al pagar otra parte) y se suman las referencias ya usadas.
  function guardar(datos) {
    if (!config || !datos || typeof datos.token !== 'string' || !datos.token) return;
    const anterior = leer();
    const misma = anterior && anterior.token === datos.token;
    const referencias = [...(misma ? anterior.referencias || [] : [])];
    if (datos.referencia && !referencias.includes(String(datos.referencia))) referencias.push(String(datos.referencia));
    const pendiente = {
      token: datos.token,
      faltante: Number(datos.faltante) || 0,
      paquete: String(datos.paquete || (misma ? anterior.paquete : '') || ''),
      cuenta: String(datos.cuenta || (misma ? anterior.cuenta : '') || ''),
      precio: Number(datos.precio) || (misma ? anterior.precio : 0) || 0,
      pagado: Number(datos.pagado) || 0,
      referencias,
      vence: misma ? anterior.vence : Date.now() + (Number(datos.horas) || HORAS_POR_DEFECTO) * 3600 * 1000,
    };
    try { localStorage.setItem(clave(), JSON.stringify(pendiente)); } catch (e) {}
    pintarAviso();
  }

  function borrar() {
    if (!config) return;
    try { localStorage.removeItem(clave()); } catch (e) {}
    pintarAviso();
  }

  const horasRestantes = (p) => Math.max(1, Math.ceil((p.vence - Date.now()) / 3600000));

  // Enlace de WhatsApp con todo lo que soporte necesita (sin la clave)
  function enlaceWhatsApp(d) {
    const lineas = [
      `Hola Level Up, el sistema me marcó *Pago Insuficiente* en ${config ? config.nombreJuego : 'la tienda'} ⚠️`,
      '',
      d.cuenta && `*Cuenta:* ${d.cuenta}`,
      d.paquete && `*Paquete:* ${d.paquete}${Number(d.precio) > 0 ? ` (${bs(d.precio)})` : ''}`,
      d.referencias && d.referencias.length ? `*Referencias:* ${d.referencias.join(', ')}` : (d.referencia && `*Referencia:* ${d.referencia}`),
      Number(d.pagado) > 0 && `*Monto que pagué:* ${bs(d.pagado)}`,
      Number(d.faltante) > 0 && `*Me faltan:* ${bs(d.faltante)}`,
      '',
      '¿Cómo hago para completarlo?',
    ].filter((l) => l !== false && l !== undefined && l !== null);
    return `https://wa.me/${WHATSAPP_TIENDA}?text=${encodeURIComponent(lineas.join('\n'))}`;
  }

  // Aviso arriba de la tienda mientras haya un pago por completar en este equipo
  function pintarAviso() {
    const existente = document.getElementById('avisoPagoPendiente');
    const p = leer();
    if (!p) { existente?.remove(); return; }
    const aviso = existente || document.createElement('div');
    aviso.id = 'avisoPagoPendiente';
    aviso.className = 'aviso-pago-pendiente';
    aviso.setAttribute('role', 'status');
    const h = horasRestantes(p);
    aviso.innerHTML = `
      <div class="aviso-pago-pendiente__icono" aria-hidden="true">!</div>
      <div class="aviso-pago-pendiente__texto">
        <strong>Tienes un pago por completar</strong>
        <span>${p.faltante > 0 ? `Faltan <b>${escapar(bs(p.faltante))}</b>` : 'Falta una parte del pago'}${p.paquete ? ` para <b>${escapar(p.paquete)}</b>` : ''}${p.cuenta ? ` · ${escapar(p.cuenta)}` : ''}</span>
        <span class="aviso-pago-pendiente__vence">Vence en ${h} ${h === 1 ? 'hora' : 'horas'}</span>
      </div>
      <button type="button" class="aviso-pago-pendiente__btn">COMPLETAR</button>`;
    aviso.querySelector('button').onclick = abrirGuardado;
    if (!existente) {
      const hero = document.querySelector('.juego-hero');
      if (hero) hero.after(aviso); else document.body.prepend(aviso);
    }
  }

  // Abre la ventana de "pago insuficiente" con los datos guardados
  async function abrirGuardado() {
    const p = leer();
    if (!p || !config) { pintarAviso(); return; }
    const $ = (id) => document.getElementById(id);
    if ($('textoMotivoWhatsApp')) {
      $('textoMotivoWhatsApp').innerHTML = `Tu pedido de <strong>${escapar(p.paquete || config.nombreJuego)}</strong>${p.cuenta ? ` (${escapar(p.cuenta)})` : ''} está apartado esperando el resto del pago.`;
    }
    if ($('waMontoEncontrado')) $('waMontoEncontrado').innerText = p.pagado > 0 ? bs(p.pagado) : 'Pagos anteriores';
    if ($('waMontoFaltante')) $('waMontoFaltante').innerText = bs(p.faltante);
    if ($('btnWhatsAppLink')) $('btnWhatsAppLink').href = enlaceWhatsApp(p);
    await config.abrir({ token: p.token, faltante: p.faltante, horas: horasRestantes(p), paquete: p.paquete, cuenta: p.cuenta });
    if ($('modalWhatsApp')) $('modalWhatsApp').style.display = 'flex';
  }

  // Captura del pago de la diferencia: solo se lee en el teléfono para llenar la referencia
  function conectarCaptura() {
    const input = document.getElementById('inputCapturaCompletar');
    const ref = document.getElementById('inputRefCompletar');
    const estado = document.getElementById('estadoCapturaCompletar');
    if (!input || !ref) return;
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      if (estado) { estado.textContent = 'Leyendo la captura...'; estado.className = 'completar-captura__estado'; }
      let referencia = null;
      try { referencia = await window.LectorReferencia?.leer(file, config.excluir ? config.excluir() : []); } catch (e) {}
      input.value = '';
      if (referencia && /^\d{5}$/.test(referencia)) {
        ref.value = referencia;
        if (estado) { estado.textContent = `Referencia leída: ${referencia}. Revísala antes de completar.`; estado.className = 'completar-captura__estado completar-captura__estado--ok'; }
      } else if (estado) {
        estado.textContent = 'No pudimos leer la referencia. Escribe los últimos 5 dígitos.';
        estado.className = 'completar-captura__estado completar-captura__estado--error';
        ref.focus();
      }
    });
  }

  function iniciar(opciones) {
    config = opciones;
    const arrancar = () => { pintarAviso(); conectarCaptura(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar); else arrancar();
  }

  // Limpia el aviso de la captura cada vez que se abre la ventana
  function limpiarCaptura() {
    const estado = document.getElementById('estadoCapturaCompletar');
    if (estado) { estado.textContent = ''; estado.className = 'completar-captura__estado'; }
  }

  window.PagoPendiente = { iniciar, guardar, borrar, leer, enlaceWhatsApp, limpiarCaptura };
})();
