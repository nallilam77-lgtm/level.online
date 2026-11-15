// Canjear código de regalo (canjear.html). POST /api/juego?accion=canjear { codigo, id } y la lista
// GET /api/juego?accion=canjes (se renueva cada 20 s con la página visible). Todo se pinta con textContent.
(function () {
  const $ = (id) => document.getElementById(id);
  const CLAVE_ID = 'levelup_ultimo_id';   // el mismo que js/ultimo-id.js: precarga el último ID de Free Fire
  let vistos = new Set();

  function el(tag, clase, texto) {
    const e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto !== undefined) e.textContent = texto;
    return e;
  }

  // "hace 3 min" / "hoy 2:15 pm" / "14/11 9:40 am"
  function cuando(iso) {
    const d = new Date(iso);
    const min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    const hora = d.toLocaleTimeString('es-VE', { timeZone: 'America/Caracas', hour: 'numeric', minute: '2-digit', hour12: true });
    const hoy = new Date().toLocaleDateString('es-VE', { timeZone: 'America/Caracas' }) === d.toLocaleDateString('es-VE', { timeZone: 'America/Caracas' });
    return hoy ? `hoy ${hora}` : `${d.toLocaleDateString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit' })} ${hora}`;
  }

  async function cargarLista() {
    try {
      const r = await (await fetch('/api/juego?accion=canjes')).json();
      if (r.status !== 'success') throw new Error(r.message);
      const quedan = $('quedan');
      quedan.hidden = false;
      quedan.textContent = r.libres > 0 ? `🎁 Quedan ${r.libres} ${r.libres === 1 ? 'código' : 'códigos'} sin canjear` : 'Por ahora no quedan códigos: espera los próximos en el canal';
      const lista = $('lista');
      lista.replaceChildren();
      if (!r.canjes.length) { lista.append(el('li', 'vacio', 'Todavía nadie ha canjeado un código.')); return; }
      const primera = vistos.size === 0;
      r.canjes.forEach((c) => {
        const clave = `${c.codigo}${c.canjeado}`;
        const li = el('li', 'canje' + (!primera && !vistos.has(clave) ? ' canje--nuevo' : ''));
        const texto = el('div', 'canje-texto');
        texto.append(el('span', 'canje-nombre', c.nombre), el('span', 'canje-detalle', `ID ${c.id_jugador} · ${c.codigo}`));
        const tiempo = el('span', 'canje-cuando');
        tiempo.append(el('strong', '', `${c.paquete} 💎`), cuando(c.canjeado));
        li.append(el('span', 'canje-icono', c.entregado ? '✅' : '⏳'), texto, tiempo);
        li.title = c.entregado ? 'Entregado' : 'En camino';
        lista.append(li);
        vistos.add(clave);
      });
    } catch (e) {
      if (!vistos.size) $('lista').replaceChildren(el('li', 'vacio', 'No se pudo cargar la lista. Recarga la página.'));
    }
  }

  function mensaje(texto, tipo) {
    const m = $('mensaje');
    m.hidden = false;
    m.className = `mensaje mensaje--${tipo}`;
    m.textContent = texto;
  }

  $('formCanje').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const codigo = $('codigo').value.trim();
    const id = $('idJugador').value.replace(/\D/g, '');
    if (codigo.replace(/[^A-Za-z0-9]/g, '').length < 10) { mensaje('Escribe el código completo, por ejemplo LU-ABCD-EFGH.', 'error'); return; }
    if (!/^\d{5,15}$/.test(id)) { mensaje('Escribe tu ID de Free Fire (solo números).', 'error'); return; }
    if (!confirm(`¿Canjear el código ${codigo.toUpperCase()} para el ID ${id}?\n\nLos diamantes llegan a ESA cuenta y el código no se puede usar otra vez.`)) return;
    const b = $('btnCanjear');
    b.disabled = true;
    b.textContent = 'Canjeando…';
    mensaje('Comprobando tu ID y el código…', 'aviso');
    try {
      const res = await fetch('/api/juego?accion=canjear', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo, id }),
      });
      const r = await res.json();
      mensaje(r.message || (r.status === 'success' ? '¡Listo!' : 'No se pudo canjear.'), r.status === 'success' ? 'ok' : res.status === 202 ? 'aviso' : 'error');
      if (r.status === 'success') {
        $('codigo').value = '';
        // Mismo formato que UltimoId.guardar (js/ultimo-id.js): la tienda de Free Fire lo ofrece después
        try { const g = JSON.parse(localStorage.getItem(CLAVE_ID) || '{}'); g.freefire = { id, zona: '', nombre: String(r.nombre || '').slice(0, 60), fecha: Date.now() }; localStorage.setItem(CLAVE_ID, JSON.stringify(g)); } catch (e) { /* sin almacenamiento */ }
      }
      cargarLista();
    } catch (e) {
      mensaje('No se pudo conectar. Revisa tu internet e intenta de nuevo.', 'error');
    } finally {
      b.disabled = false;
      b.textContent = 'Canjear';
    }
  });

  // Último ID de Free Fire de este equipo (js/ultimo-id.js) y código desde el enlace (?codigo=LU-ABCD-EFGH)
  try {
    const g = JSON.parse(localStorage.getItem(CLAVE_ID) || '{}');
    if (g.freefire && g.freefire.id) $('idJugador').value = g.freefire.id;
  } catch (e) { /* sin almacenamiento */ }
  const delEnlace = new URLSearchParams(location.search).get('codigo');
  if (delEnlace) $('codigo').value = delEnlace.slice(0, 20);

  cargarLista();
  setInterval(() => { if (document.visibilityState === 'visible') cargarLista(); }, 20000);
})();
