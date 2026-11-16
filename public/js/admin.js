// =========================================================================
// PANEL ADMIN (admin.html) sobre Supabase (desde 2026-11-13; el panel de Firebase se quitó). Pago Móvil que ven
// los clientes: Pagos → dos cuentas guardadas, una en uso (desde 2026-11-15; ver cargarCuentasPm).
// Entra con la sesión de Google de la tienda (js/sesion.js) y solo funciona si la cuenta está en la tabla
// "administradores": la base lo comprueba en cada consulta (RLS y es_admin(), supabase/tienda.sql), así
// que esta página no protege nada por sí sola. Secciones: resumen de ventas (admin_resumen), pedidos en
// vivo (tabla "recargas"), cuentas con sus recargas y fichas (admin_cuentas), ranking del minijuego
// (juego_revision), códigos de creadores con su tasa, pagos y PIN (admin_codigo*, supabase/codigos.sql) y
// espacio de la base con limpieza de semanas viejas (admin_espacio / admin_borrar_viejo). Todo lo que viene de la base se pinta con textContent.
// =========================================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const JUEGOS = {
    freefire: 'Free Fire', bloodstrike: 'Blood Strike', mobilelegends: 'Mobile Legends', roblox: 'Roblox',
    fcmobile: 'FC Mobile', codmobile: 'COD Mobile', clashroyale: 'Clash Royale',
  };
  const ESTADOS = {
    completado: 'Entregada', en_proceso: 'En proceso', pendiente: 'Recibido', incompleto: 'Pago incompleto',
    en_revision: 'En revisión', problema: 'Con problema', reembolsado: 'Reembolsada',
  };
  const CLAVE_TASA = 'levelup_admin_tasa';
  // Tiendas manuales (supabase/manuales.sql): sin Central One, la recarga la hace el equipo
  const MANUALES = new Set(['fcmobile', 'codmobile', 'clashroyale']);
  let cliente = null;
  let pedidos = [];
  let canal = null;

  const bs = (n) => Number(n || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fecha = (iso) => new Date(iso).toLocaleString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
  function el(tag, clase, texto) {
    const e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto !== undefined) e.textContent = texto;
    return e;
  }

  // Botón que abre WhatsApp con el cliente (teléfono "+58414…" de la tabla perfiles) y un mensaje listo
  function enlaceWhatsapp(telefono, mensaje) {
    const a = el('a', 'enlace-wa', 'WhatsApp ' + telefono.replace(/^\+58(\d{3})(\d{7})$/, '0$1 $2'));
    a.href = `https://wa.me/${telefono.replace(/\D/g, '')}${mensaje ? '?text=' + encodeURIComponent(mensaje) : ''}`;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  // Inicio del día y de la semana (lunes) en Venezuela (UTC-4), como api/_lib/semana.js
  function iniciosVE(ahora = Date.now()) {
    const DIA = 864e5, DESFASE = 4 * 36e5;
    const dia = Math.floor((ahora - DESFASE) / DIA) * DIA;
    const lunes = dia - ((new Date(dia).getUTCDay() + 6) % 7) * DIA;
    return { dia: new Date(dia + DESFASE), semana: new Date(lunes + DESFASE), semanaPasada: new Date(lunes - 7 * DIA + DESFASE) };
  }

  // Hora corta para las filas: hoy solo la hora; otro día, también la fecha
  function horaCorta(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const hoy = d >= iniciosVE().dia;
    return d.toLocaleString('es-VE', hoy
      ? { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hour12: true }
      : { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
  }

  // Fila compacta (pedidos y pagos): una línea con hora, qué es, monto y estado; al tocarla se abre el
  // detalle. "abiertas" recuerda las que abrió el administrador para que renovar la lista no las cierre.
  const abiertas = new Set();
  function filaCompacta({ clave, hora, titulo, monto, etiqueta, claseEtiqueta, nueva, abrir }) {
    const li = el('li', 'fila' + (nueva ? ' fila--nueva' : ''));
    const det = el('details');
    const resumen = el('summary', 'fila-resumen');
    resumen.append(el('span', 'fila-hora', hora), el('span', 'fila-texto', titulo), el('span', 'fila-monto', monto || ''),
      el('span', 'etiqueta ' + (claseEtiqueta || ''), etiqueta));
    const cuerpo = el('div', 'fila-detalle');
    det.append(resumen, cuerpo);
    if (abrir || (clave && abiertas.has(clave))) det.open = true;
    resumen.addEventListener('click', () => setTimeout(() => {
      if (!clave) return;
      if (det.open) abiertas.add(clave); else abiertas.delete(clave);
    }, 0));
    li.append(det);
    return { li, cuerpo };
  }

  // Lee TODAS las filas de una consulta, de 1000 en 1000 (Supabase no da más de 1000 por vez)
  async function leerTodo(armar) {
    const filas = [];
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await armar().range(desde, desde + 999);
      if (error) throw error;
      filas.push(...(data || []));
      if (!data || data.length < 1000) return filas;
    }
  }
  // Desde cuándo según el periodo elegido (null = todo)
  function desdePeriodo(periodo) {
    if (periodo === 'dia') return iniciosVE().dia;
    if (periodo === '7' || periodo === '30') return new Date(Date.now() - Number(periodo) * 864e5);
    return null;
  }

  function estado(texto, conBoton) {
    $('estadoTexto').textContent = texto;
    $('btnEntrarAdmin').hidden = !conBoton;
    $('panelEstado').hidden = false;
    $('panel').hidden = true;
  }

  // ---------------------------------------------------------------- pestañas
  document.querySelectorAll('[data-seccion]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-seccion]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.seccion').forEach((s) => { s.hidden = s.id !== 'seccion-' + b.dataset.seccion; });
    // Minijuego: el ranking y las fichas por partida / Bs por ficha (vienen con admin_precios)
    if (b.dataset.seccion === 'juego') { cargarJuego(); cargarPrecios().catch(() => {}); }
    if (b.dataset.seccion === 'espacio') cargarEspacio();
    if (b.dataset.seccion === 'cuentas') cargarCuentas();
    if (b.dataset.seccion === 'creadores') cargarCodigos();
    if (b.dataset.seccion === 'precios') cargarPrecios();
    if (b.dataset.seccion === 'roblox') cargarRoblox();
    if (b.dataset.seccion === 'canjes') cargarCanjes();
    if (b.dataset.seccion === 'manuales') cargarManuales();
    if (b.dataset.seccion === 'revision') { cargarRevision(); cargarRuleta().catch(() => {}); }
    if (b.dataset.seccion === 'pagos') { cargarPagos(); cargarPorAprobar().catch(() => {}); }
    // Ajustes: cuentas de Pago Móvil, modo de Free Fire y Google Sheets (tabla configuracion)
    if (b.dataset.seccion === 'ajustes') { cargarMantenimiento().catch(() => {}); cargarPagosManual().catch(() => {}); cargarAvisos().catch(() => {}); cargarCuentasPm(); cargarModoFF().catch(() => {}); cargarHojas().catch(() => {}); }
  }));

  // ---------------------------------------------------------------- resumen
  let ultimoResumen = [];
  function pintarResumen() {
    const filas = ultimoResumen;
    const entregadas = filas.filter((f) => f.estado === 'completado');
    const totalBs = entregadas.reduce((s, f) => s + Number(f.total || 0), 0);
    const tasa = Number($('tasa').value) || 0;
    $('kpiEntregadas').textContent = entregadas.reduce((s, f) => s + f.pedidos, 0).toLocaleString('es-VE');
    $('kpiBs').textContent = bs(totalBs);
    $('kpiUsd').textContent = tasa > 0 ? '$' + (totalBs / tasa).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '–';
    $('kpiRevisar').textContent = filas.filter((f) => f.estado === 'en_revision' || f.estado === 'problema').reduce((s, f) => s + f.pedidos, 0);
    const porJuego = {};
    filas.forEach((f) => {
      const j = porJuego[f.juego] || (porJuego[f.juego] = { entregadas: 0, bs: 0, otras: 0 });
      if (f.estado === 'completado') { j.entregadas += f.pedidos; j.bs += Number(f.total || 0); } else j.otras += f.pedidos;
    });
    const cuerpo = $('tablaJuegos');
    cuerpo.replaceChildren();
    const juegos = Object.keys(porJuego).sort((a, b) => porJuego[b].bs - porJuego[a].bs);
    if (!juegos.length) { const tr = el('tr'); const td = el('td', 'vacio', 'Sin pedidos en este periodo.'); td.colSpan = 4; tr.append(td); cuerpo.append(tr); return; }
    juegos.forEach((j) => {
      const tr = el('tr');
      tr.append(el('td', '', JUEGOS[j] || j), el('td', '', String(porJuego[j].entregadas)), el('td', '', bs(porJuego[j].bs)), el('td', '', String(porJuego[j].otras)));
      cuerpo.append(tr);
    });
  }

  async function cargarResumen() {
    const p = $('periodo').value;
    const desde = p === 'dia' ? iniciosVE().dia : new Date(Date.now() - Number(p) * 864e5);
    const { data, error } = await cliente.rpc('admin_resumen', { p_desde: desde.toISOString() });
    if (error) { console.error(error); return; }
    ultimoResumen = (data || []).map((f) => ({ ...f, pedidos: Number(f.pedidos) || 0 }));
    pintarResumen();
  }
  $('periodo').addEventListener('change', cargarResumen);
  try { $('tasa').value = localStorage.getItem(CLAVE_TASA) || ''; } catch (e) { /* sin almacenamiento */ }
  $('tasa').addEventListener('input', () => { try { localStorage.setItem(CLAVE_TASA, $('tasa').value); } catch (e) { /* sin almacenamiento */ } pintarResumen(); });

  // ---------------------------------------------------------------- saldo de Central One
  // GET /api/juego?accion=saldo_centralone (Vercel tiene las llaves) y el último aviso de saldo que mandó
  // Central One al webhook (configuracion "centralone_saldo": balance.low, deposit.approved…).
  const dolares = (n) => (n === null || n === undefined ? '–' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  // Libro diario en Google Sheets (configuracion "hojas_ventas"; api/_lib/libro.js). Sin valor = encendido.
  async function cargarHojas() {
    const { data } = await cliente.from('configuracion').select('valor').eq('clave', 'hojas_ventas').maybeSingle();
    const encendido = !(data && data.valor === false);
    $('hojasVentas').checked = encendido;
    $('mensajeHojas').textContent = encendido ? 'Encendido: las ventas se anotan en Supabase y en las hojas.' : 'Apagado: las ventas se anotan solo en Supabase.';
  }
  $('hojasVentas').addEventListener('change', async (ev) => {
    const encender = ev.target.checked;
    const texto = encender
      ? '¿Volver a anotar las ventas en Google Sheets?'
      : '¿Dejar de anotar las ventas en Google Sheets?\n\nTodo sigue guardado en Supabase (Pedidos, Revisión, Creadores) y puedes descargar las ventas en Excel desde Pedidos. Se aplica en menos de 1 minuto.';
    if (!confirm(texto)) { cargarHojas(); return; }
    const { error } = await cliente.from('configuracion').upsert({ clave: 'hojas_ventas', valor: encender, publico: false, actualizado: new Date().toISOString() }, { onConflict: 'clave' });
    if (error) { console.error(error); alert('No se pudo guardar. Intenta de nuevo.'); }
    cargarHojas();
  });

  // Free Fire: directo a Central One o como antes (configuracion "ff_modo"; Vercel lo lee cada 30 s)
  const TEXTO_MODO_FF = { central_one: 'Directo a Central One (sin la hoja)', hoja: 'Como antes (la hoja decide)' };
  async function cargarModoFF() {
    const { data } = await cliente.from('configuracion').select('valor').eq('clave', 'ff_modo').maybeSingle();
    const modo = (data && data.valor) === 'central_one' ? 'central_one' : 'hoja';
    document.querySelectorAll('input[name="modoFF"]').forEach((r) => { r.checked = r.value === modo; });
    $('mensajeModoFF').textContent = `En uso: ${TEXTO_MODO_FF[modo]}.`;
  }
  $('formModoFF').addEventListener('change', async (ev) => {
    const modo = ev.target.value;
    if (!TEXTO_MODO_FF[modo]) return;
    if (!confirm(`¿Cambiar Free Fire a "${TEXTO_MODO_FF[modo]}"?\n\nSe aplica en menos de 1 minuto a las recargas nuevas.`)) { cargarModoFF(); return; }
    const { error } = await cliente.from('configuracion').upsert({ clave: 'ff_modo', valor: modo, publico: false, actualizado: new Date().toISOString() }, { onConflict: 'clave' });
    if (error) { console.error(error); alert('No se pudo guardar. Intenta de nuevo.'); }
    cargarModoFF();
  });
  // Tienda en mantenimiento (configuracion "mantenimiento", publico; js/mantenimiento.js manda a los
  // clientes a /mantenimiento.html). Mientras está encendido, el panel lo avisa arriba.
  async function cargarMantenimiento() {
    const { data } = await cliente.from('configuracion').select('valor').eq('clave', 'mantenimiento').maybeSingle();
    const valor = data && data.valor;
    const activo = !!(valor && valor.activo === true);
    $('mantenimientoActivo').checked = activo;
    $('avisoMantenimiento').hidden = !activo;
    $('mensajeMantenimiento').textContent = activo
      ? `🛠️ En mantenimiento${valor.desde ? ' desde ' + fecha(valor.desde) : ''}: los clientes ven la página de "Estamos mejorando".`
      : '✅ La tienda está abierta.';
  }
  $('mantenimientoActivo').addEventListener('change', async (ev) => {
    const activar = ev.target.checked;
    const texto = activar
      ? '¿Poner la tienda en MANTENIMIENTO?\n\nLos clientes que entren verán "Estamos mejorando la tienda" y el botón para recargar por WhatsApp. No podrán recargar en la web hasta que lo apagues.'
      : '¿Abrir la tienda otra vez?\n\nLos clientes vuelven a recargar en la web al instante.';
    if (!confirm(texto)) { cargarMantenimiento(); return; }
    ev.target.disabled = true;
    const { error } = await cliente.from('configuracion').upsert({ clave: 'mantenimiento', valor: { activo: activar, desde: new Date().toISOString() }, publico: true, actualizado: new Date().toISOString() }, { onConflict: 'clave' });
    ev.target.disabled = false;
    if (error) { console.error(error); alert('No se pudo guardar. Intenta de nuevo.'); }
    cargarMantenimiento();
  });
  $('irMantenimiento').addEventListener('click', () => {
    document.querySelector('[data-seccion="ajustes"]').click();
    $('mantenimientoActivo').focus();
  });

  // Avisos en las tiendas (configuracion "avisos_juegos", publico; los muestra js/aviso-juego.js):
  // { <juego>|todas: { titulo, texto, activo, id } }. Un aviso por juego; el id nuevo en cada cambio hace
  // que vuelva a salir a quien ya cerró el anterior.
  const NOMBRE_AVISO = Object.assign({ todas: 'Todas las tiendas' }, JUEGOS);
  let avisos = {};
  async function cargarAvisos() {
    const { data, error } = await cliente.from('configuracion').select('valor').eq('clave', 'avisos_juegos').maybeSingle();
    const lista = $('listaAvisos');
    if (error) { console.error(error); lista.replaceChildren(el('li', 'vacio', 'No se pudieron cargar los avisos.')); return; }
    avisos = (data && data.valor && typeof data.valor === 'object') ? data.valor : {};
    lista.replaceChildren();
    const juegos = Object.keys(NOMBRE_AVISO).filter((j) => avisos[j] && avisos[j].texto);
    if (!juegos.length) { lista.append(el('li', 'vacio', 'No hay avisos. Escribe uno arriba.')); return; }
    juegos.forEach((j) => {
      const a = avisos[j];
      const li = el('li', 'pedido');
      const cabeza = el('div', 'pedido-cabeza');
      cabeza.append(el('strong', '', `${NOMBRE_AVISO[j]}${a.titulo ? ' · ' + a.titulo : ''}`),
        el('span', 'etiqueta ' + (a.activo ? 'etiqueta--completado' : 'etiqueta--en_revision'), a.activo ? 'Se muestra' : 'Oculto'));
      const acciones = el('div', 'acciones-cuenta');
      acciones.append(
        boton('✏️ Editar', 'btn-ver', () => {
          $('avisoJuego').value = j; $('avisoTitulo').value = a.titulo || ''; $('avisoTexto').value = a.texto || '';
          $('avisoActivo').checked = !!a.activo; $('avisoTexto').focus();
        }),
        boton(a.activo ? 'Ocultar' : 'Mostrar', 'btn-ver', (b) => guardarAvisos({ ...avisos, [j]: { ...a, activo: !a.activo, id: String(Date.now()) } }, b)),
        boton('🗑️ Quitar', 'btn-ver btn-ver--peligro', (b) => {
          if (!confirm(`¿Quitar el aviso de ${NOMBRE_AVISO[j]}?`)) return;
          const resto = { ...avisos }; delete resto[j];
          guardarAvisos(resto, b);
        }));
      li.append(cabeza, el('span', 'precio-detalle', a.texto), acciones);
      lista.append(li);
    });
  }
  async function guardarAvisos(valor, b) {
    if (b) b.disabled = true;
    const { error } = await cliente.from('configuracion').upsert({ clave: 'avisos_juegos', valor, publico: true, actualizado: new Date().toISOString() }, { onConflict: 'clave' });
    if (b) b.disabled = false;
    if (error) { console.error(error); alert('No se pudo guardar. Intenta de nuevo.'); return false; }
    await cargarAvisos();
    return true;
  }
  $('formAviso').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const juego = $('avisoJuego').value;
    const texto = $('avisoTexto').value.trim();
    const msg = $('mensajeAviso');
    if (!NOMBRE_AVISO[juego]) return;
    if (!texto) { msg.textContent = 'Escribe el mensaje del aviso.'; return; }
    if (avisos[juego] && avisos[juego].texto && !confirm(`${NOMBRE_AVISO[juego]} ya tiene un aviso. ¿Reemplazarlo por este?`)) return;
    const aviso = { titulo: $('avisoTitulo').value.trim().slice(0, 80), texto: texto.slice(0, 600), activo: $('avisoActivo').checked, id: String(Date.now()) };
    if (await guardarAvisos({ ...avisos, [juego]: aviso }, $('btnAviso'))) {
      msg.textContent = aviso.activo ? `✅ Listo: el aviso ya sale en ${NOMBRE_AVISO[juego]}.` : '✅ Guardado (oculto).';
      $('avisoTitulo').value = ''; $('avisoTexto').value = ''; $('avisoActivo').checked = true;
    }
  });

  async function cargarSaldo() {
    const caja = $('cuentasSaldo');
    try {
      const { data: s } = await cliente.auth.getSession();
      const res = await fetch('/api/juego?accion=saldo_centralone', { headers: { Authorization: 'Bearer ' + ((s && s.session && s.session.access_token) || '') } });
      const r = await res.json();
      if (r.status !== 'success') throw new Error(r.message || 'sin saldo');
      caja.replaceChildren(...(r.cuentas || []).map((c) => {
        const bloque = el('div', 'cuenta-saldo');
        if (r.cuentas.length > 1) bloque.append(el('small', 'cuenta-saldo__juegos', 'Llave de ' + c.juegos.join(', ')));
        if (c.error) { bloque.append(el('p', 'nota', '⚠️ ' + c.error)); return bloque; }
        const kpis = el('div', 'kpis');
        const kpi = (titulo, valor, clase) => { const k = el('div', 'kpi' + (clase ? ' ' + clase : '')); k.append(el('small', '', titulo), el('strong', '', dolares(valor))); return k; };
        kpis.append(kpi('Disponible', c.disponible, c.disponible !== null && c.disponible < 30 ? 'kpi--aviso' : ''), kpi('Retenido', c.retenido), kpi('Total', c.total));
        bloque.append(kpis);
        return bloque;
      }));
      if (!(r.cuentas || []).length) caja.replaceChildren(el('p', 'nota', 'Vercel no tiene llaves de Central One.'));
    } catch (e) {
      caja.replaceChildren(el('p', 'nota', 'No se pudo leer el saldo. Toca Actualizar.'));
    }
    // Último aviso de saldo (webhook)
    const { data } = await cliente.from('configuracion').select('valor').eq('clave', 'centralone_saldo').maybeSingle();
    const a = data && data.valor;
    const alerta = $('alertaSaldo');
    alerta.hidden = !a;
    if (!a) return;
    alerta.className = 'alerta-saldo' + (a.evento === 'balance.low' ? ' alerta-saldo--baja' : a.evento === 'deposit.rejected' ? ' alerta-saldo--baja' : ' alerta-saldo--ok');
    alerta.textContent = a.evento === 'balance.low'
      ? `🚨 Saldo bajo: quedaban ${dolares(a.disponible)} (tu mínimo es ${dolares(a.umbral)}) · ${fecha(a.fecha)}. Recarga saldo para que no fallen las ventas.`
      : a.evento === 'deposit.rejected'
        ? `❌ Central One rechazó un depósito · ${fecha(a.fecha)}${a.motivo ? ': ' + a.motivo : ''}`
        : `✅ Saldo acreditado${a.monto !== null ? ': ' + dolares(a.monto) : ''}${a.disponible !== null ? ` · disponible ${dolares(a.disponible)}` : ''} · ${fecha(a.fecha)}`;
  }
  $('actualizarSaldo').addEventListener('click', cargarSaldo);

  // ---------------------------------------------------------------- alarma de referencias
  // supabase/pagos.sql (pagos_anotar_intento): 20 o más referencias distintas que no existen en 10 minutos
  // = alguien puede estar adivinando los últimos 5 dígitos. Se revisa cada minuto con el panel abierto.
  async function cargarAlarma() {
    const { data } = await cliente.from('configuracion').select('valor').eq('clave', 'alarma_referencias').maybeSingle();
    const a = data && data.valor;
    const activa = !!(a && a.desde);
    $('alarmaReferencias').hidden = !activa;
    if (!activa) return;
    $('alarmaTexto').textContent = `Desde ${fecha(a.desde)} hasta ${fecha(a.hasta)} escribieron ${a.total} referencias que no existen `
      + `(hasta ${a.pico} distintas en 10 minutos). Puede ser alguien adivinando los últimos 5 dígitos para usar el pago de otro cliente. `
      + 'Cada conexión ya queda bloqueada 1 hora después de 15 fallos. Si un cliente reclama que su pago "ya fue usado", revisa en Pedidos las recargas de esas horas.';
  }
  $('alarmaVisto').addEventListener('click', async () => {
    const { error } = await cliente.from('configuracion').update({ valor: {} }).eq('clave', 'alarma_referencias');
    if (error) { alert(textoError(error, 'No se pudo apagar la alarma.')); return; }
    $('alarmaReferencias').hidden = true;
  });
  setInterval(() => { if (cliente && document.visibilityState === 'visible') cargarAlarma().catch(() => {}); }, 60000);

  // ---------------------------------------------------------------- pedidos
  // Motivo de Central One (failure.code / failure.action) para el administrador
  const MOTIVO_ADMIN = {
    invalid_player: 'ID inválido o de otra región', not_eligible: 'La cuenta no puede recibir ese producto',
    quantity_not_supported: 'Cantidad no permitida', price_changed: 'Cambió el precio', out_of_stock: 'Sin stock en Central One',
    provider_unavailable: 'Proveedor caído o en mantenimiento', provider_rejected: 'El proveedor la rechazó',
    cancelled: 'Cancelada', unknown: 'Motivo desconocido',
  };
  const ACCION_ADMIN = {
    fix_and_retry: 'corrige el dato y vuelve a comprar', do_not_retry: 'no la reintentes: cambia el producto o devuelve el pago',
    retry_later: 'reintenta más tarde', contact_support: 'escribe a soporte de Central One con el reference_code',
  };
  function tarjetaPedido(p, nuevo, abrir) {
    const { li, cuerpo } = filaCompacta({
      clave: 'pedido:' + p.id_pedido, hora: horaCorta(p.creado), titulo: `${JUEGOS[p.juego] || p.juego} · ${p.paquete}`,
      monto: p.precio ? `${bs(p.precio)} Bs` : '', etiqueta: ESTADOS[p.estado] || p.estado, claseEtiqueta: 'etiqueta--' + p.estado,
      nueva: nuevo, abrir,
    });
    cuerpo.append(
      el('span', '', `Cuenta: ${p.cuenta}`),
      el('span', '', `${p.precio ? `${bs(p.precio)} Bs` : 'Sin precio'}${p.referencia ? ` · ref. …${p.referencia}` : ''}`),
      el('span', '', `${fecha(p.creado)}${p.usuario ? ' · con cuenta' : ' · sin cuenta'}`),
      el('span', '', `Pedido ${p.id_pedido}`),
    );
    if (p.motivo_fallo) {
      cuerpo.append(el('span', 'motivo-fallo', `Central One: ${MOTIVO_ADMIN[p.motivo_fallo] || p.motivo_fallo}${ACCION_ADMIN[p.motivo_accion] ? ` → ${ACCION_ADMIN[p.motivo_accion]}` : ''}`));
    }
    return li;
  }

  function pintarPedidos(nuevoId) {
    const filtro = $('filtroEstado').value;
    const texto = $('buscar').value.trim().toLowerCase();
    const lista = $('listaPedidos');
    lista.replaceChildren();
    const visibles = pedidos.filter((p) => (!filtro || p.estado === filtro)
      && (!texto || [p.cuenta, p.paquete, p.referencia, p.id_pedido, JUEGOS[p.juego]].join(' ').toLowerCase().includes(texto)));
    $('cuentaPedidos').textContent = `${visibles.length} ${visibles.length === 1 ? 'pedido' : 'pedidos'}`;
    if (!visibles.length) { lista.append(el('li', 'vacio', 'No hay pedidos con ese filtro.')); return; }
    // Buscando con pocos resultados: se abren solos
    const abrir = !!texto && visibles.length <= 3;
    const trozo = document.createDocumentFragment();
    visibles.forEach((p) => trozo.append(tarjetaPedido(p, p.id_pedido === nuevoId, abrir)));
    lista.append(trozo);
  }

  async function cargarPedidos() {
    $('cuentaPedidos').textContent = 'Cargando…';
    const desde = desdePeriodo($('periodoPedidos').value);
    try {
      pedidos = await leerTodo(() => {
        let q = cliente.from('recargas')
          .select('id_pedido,juego,cuenta,paquete,precio,referencia,estado,creado,usuario,motivo_fallo,motivo_accion')
          .order('creado', { ascending: false });
        if (desde) q = q.gte('creado', desde.toISOString());
        return q;
      });
    } catch (error) {
      console.error(error);
      $('cuentaPedidos').textContent = '';
      $('listaPedidos').replaceChildren(el('li', 'vacio', 'No se pudieron cargar los pedidos.'));
      return;
    }
    pintarPedidos();
  }
  $('periodoPedidos').addEventListener('change', cargarPedidos);
  $('filtroEstado').addEventListener('change', () => pintarPedidos());
  $('buscar').addEventListener('input', () => pintarPedidos());

  // En vivo: pedidos nuevos y cambios de estado (Realtime respeta el permiso de administrador)
  function escuchar() {
    if (canal) cliente.removeChannel(canal);
    canal = cliente.channel('admin-recargas')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recargas' }, (cambio) => {
        const n = cambio.new;
        if (!n || !n.id_pedido) return;
        const i = pedidos.findIndex((p) => p.id_pedido === n.id_pedido);
        if (i >= 0) pedidos[i] = Object.assign({}, pedidos[i], n); else pedidos.unshift(n);
        pintarPedidos(n.id_pedido);
        cargarResumen();
        // Pedido nuevo de una tienda manual: la pestaña Manuales (y su contador) se pone al día
        if (MANUALES.has(n.juego)) cargarManuales().catch(() => {});
      })
      .subscribe();
  }

  // ---------------------------------------------------------------- minijuego
  async function cargarJuego() {
    const s = iniciosVE();
    const pasada = $('semanaJuego').value === 'pasada';
    const { data, error } = await cliente.rpc('juego_revision', {
      p_desde: (pasada ? s.semanaPasada : s.semana).toISOString(), p_hasta: pasada ? s.semana.toISOString() : null, p_limite: 10,
    });
    const lista = $('listaJuego');
    lista.replaceChildren();
    if (error) { lista.append(el('li', 'vacio', 'No se pudo cargar el ranking.')); return; }
    if (!data || !data.length) { lista.append(el('li', 'vacio', 'Nadie ha jugado en esa semana.')); return; }
    data.forEach((f) => {
      const li = el('li');
      const cabeza = el('div', 'pedido-cabeza');
      cabeza.append(el('strong', '', `${f.puesto}. ${f.nombre || f.correo} · ${Number(f.puntos).toLocaleString('es-VE')} pts`));
      if (f.revisar) cabeza.append(el('span', 'etiqueta etiqueta--revisar', 'Revisar'));
      const st = f.stats || {};
      li.append(cabeza,
        el('span', '', `Mejor partida: ${f.segundos} s · atrapó ${st.atrapados ?? '?'} y se le escaparon ${st.escapados ?? '?'} · ${st.golpes ?? '?'} golpes`),
        el('span', '', `${f.partidas_validas} partidas válidas, ${f.partidas_invalidas} inválidas · ${fecha(f.terminada)}`),
        el('span', '', f.correo));
      const acciones = el('div', 'acciones-cuenta');
      if (f.telefono) {
        const premio = f.puesto === 1 ? '¡Ganaste la Lluvia de Diamantes de la semana! ' : '';
        acciones.append(enlaceWhatsapp(f.telefono, `Hola${f.nombre ? ' ' + f.nombre.split(' ')[0] : ''}, te escribimos de Level Up. ${premio}`.trim()));
      } else acciones.append(el('span', 'sin-telefono', 'Sin WhatsApp'));
      li.append(acciones);
      lista.append(li);
    });
  }
  $('semanaJuego').addEventListener('change', cargarJuego);

  // ---------------------------------------------------------------- espacio
  // La base decide qué se puede borrar y protege esta semana y la pasada (supabase/tienda.sql)
  const LIMITE_PLAN = 500 * 1024 * 1024;
  const TABLAS = {
    recargas: 'Pedidos', fidelidad: 'Fidelidad', fidelidad_usos: 'Usos de fidelidad', ventas_paquetes: 'Ventas por paquete',
    juego_partidas: 'Partidas del minijuego', juego_movimientos: 'Movimientos de fichas', juego_fichas: 'Saldos de fichas',
    juego_ajustes: 'Ajustes del minijuego', limites: 'Bloqueos por intentos', configuracion: 'Configuración',
    administradores: 'Administradores', pagos_recibidos: 'Pagos recibidos (sin uso)',
  };
  const BORRABLES = {
    juego_partidas: 'Partidas terminadas del minijuego',
    juego_movimientos: 'Gasto de fichas en partidas',
    limites: 'Bloqueos por intentos ya vencidos',
  };
  const tamano = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' kB');

  function fechaCorte() {
    return new Date(iniciosVE().semanaPasada.getTime() - Number($('antesDe').value) * 7 * 864e5);
  }

  async function cargarEspacio() {
    const { data, error } = await cliente.rpc('admin_espacio', { p_antes: fechaCorte().toISOString() });
    const lista = $('listaBorrar');
    if (error || !data) {
      console.error(error);
      $('textoEspacio').textContent = 'No se pudo leer';
      lista.replaceChildren(el('li', 'vacio', 'No se pudo leer el espacio.'));
      return;
    }
    const pct = Math.min(100, (Number(data.total) / LIMITE_PLAN) * 100);
    $('barraEspacio').style.width = pct.toFixed(1) + '%';
    $('medidorEspacio').setAttribute('aria-valuenow', pct.toFixed(1));
    $('medidorEspacio').classList.toggle('medidor--alto', pct >= 80);
    $('textoEspacio').textContent = `${tamano(Number(data.total))} usados (${pct.toFixed(1)} %)`;
    $('kpiBase').textContent = tamano(Number(data.total));
    $('kpiConexiones').textContent = `${Number(data.conexiones) || 0} / ${Number(data.conexiones_max) || '?'}`;
    $('kpiVersion').textContent = String(data.version || '–');

    const cuerpo = $('tablaEspacio');
    cuerpo.replaceChildren();
    (data.tablas || []).forEach((t) => {
      const tr = el('tr');
      tr.append(el('td', '', TABLAS[t.tabla] || t.tabla), el('td', '', tamano(Number(t.bytes))), el('td', '', Number(t.filas).toLocaleString('es-VE')));
      cuerpo.append(tr);
    });

    lista.replaceChildren();
    Object.keys(BORRABLES).forEach((tabla) => {
      const n = Number((data.borrables || {})[tabla]) || 0;
      const li = el('li', 'pedido');
      const fila = el('div', 'borrar-fila');
      const texto = el('div', 'pedido-cabeza');
      texto.append(el('strong', '', `${BORRABLES[tabla]} · ${n.toLocaleString('es-VE')}`));
      const boton = el('button', 'btn btn--peligro', 'Borrar');
      boton.type = 'button';
      boton.disabled = n === 0;
      boton.addEventListener('click', () => borrarViejo(tabla, n, boton));
      fila.append(texto, boton);
      li.append(fila);
      lista.append(li);
    });
  }

  async function borrarViejo(tabla, n, boton) {
    if (!confirm(`¿Borrar ${n.toLocaleString('es-VE')} filas de "${BORRABLES[tabla]}"?\n\nNo se puede deshacer.`)) return;
    boton.disabled = true;
    const { data, error } = await cliente.rpc('admin_borrar_viejo', { p_tabla: tabla, p_antes: fechaCorte().toISOString() });
    if (error) console.error(error);
    $('espacioMensaje').textContent = error
      ? 'No se pudo borrar. Intenta de nuevo.'
      : `✅ Borradas ${Number(data || 0).toLocaleString('es-VE')} filas. El tamaño baja poco a poco: Supabase reutiliza ese espacio.`;
    cargarEspacio();
  }
  $('antesDe').addEventListener('change', cargarEspacio);
  $('actualizarEspacio').addEventListener('click', () => { cargarEspacio(); cargarCuentas(); });

  // ---------------------------------------------------------------- cuentas
  let cuentas = [];
  const corta = (iso) => (iso ? new Date(iso).toLocaleDateString('es-VE', { timeZone: 'America/Caracas', day: '2-digit', month: '2-digit', year: '2-digit' }) : 'nunca');

  function pintarCuentas() {
    const texto = $('buscarCuenta').value.trim().toLowerCase();
    const lista = $('listaCuentas');
    lista.replaceChildren();
    const visibles = cuentas.filter((c) => !texto || `${c.correo} ${c.nombre || ''} ${c.telefono || ''}`.toLowerCase().includes(texto));
    if (!visibles.length) { lista.append(el('li', 'vacio', 'No hay cuentas con esa búsqueda.')); return; }
    visibles.forEach((c) => {
      const li = el('li', 'pedido');
      const cabeza = el('div', 'pedido-cabeza');
      cabeza.append(el('strong', '', c.nombre || c.correo || 'Sin correo'));
      if (Number(c.recargas) > 0) cabeza.append(el('span', 'etiqueta etiqueta--completado', `${c.recargas} recarga${Number(c.recargas) === 1 ? '' : 's'}`));
      li.append(cabeza,
        el('span', '', `${c.correo || ''}${Number(c.gastado) > 0 ? ` · ${bs(c.gastado)} Bs` : ''} · ${Number(c.fichas) || 0} fichas`),
        el('span', '', `Creada ${corta(c.creado)} · última entrada ${corta(c.ultimo)}`));
      const acciones = el('div', 'acciones-cuenta');
      if (c.telefono) acciones.append(enlaceWhatsapp(c.telefono, `Hola${c.nombre ? ' ' + c.nombre.split(' ')[0] : ''}, te escribimos de Level Up.`));
      else acciones.append(el('span', 'sin-telefono', 'Sin WhatsApp'));
      if (Number(c.recargas) > 0 || Number(c.gastado) > 0) {
        const ver = el('button', 'btn-ver', 'Ver recargas');
        ver.type = 'button';
        ver.addEventListener('click', () => verRecargasCuenta(c.id, li, ver));
        acciones.append(ver);
      }
      li.append(acciones);
      lista.append(li);
    });
  }

  // Últimas 20 recargas de una cuenta (cualquier estado), debajo de su tarjeta
  async function verRecargasCuenta(id, li, boton) {
    const abierta = li.querySelector('.recargas-cuenta');
    if (abierta) { abierta.remove(); boton.textContent = 'Ver recargas'; return; }
    boton.disabled = true;
    const { data, error } = await cliente.from('recargas')
      .select('id_pedido,juego,cuenta,paquete,precio,referencia,estado,creado,usuario')
      .eq('usuario', id).order('creado', { ascending: false }).limit(20);
    boton.disabled = false;
    const sub = el('ul', 'pedidos recargas-cuenta');
    if (error) sub.append(el('li', 'vacio', 'No se pudieron cargar.'));
    else if (!data || !data.length) sub.append(el('li', 'vacio', 'Sin recargas con esta cuenta.'));
    else data.forEach((p) => sub.append(tarjetaPedido(p, false)));
    li.append(sub);
    boton.textContent = 'Ocultar recargas';
  }

  async function cargarCuentas() {
    const { data, error } = await cliente.rpc('admin_cuentas', { p_limite: Number($('limiteCuentas').value) });
    if (error || !data) {
      console.error(error);
      $('listaCuentas').replaceChildren(el('li', 'vacio', 'No se pudieron cargar las cuentas.'));
      return;
    }
    const n = (x) => Number(x || 0).toLocaleString('es-VE');
    $('kpiCuentas').textContent = n(data.total);
    $('kpiCuentasSb').textContent = n(data.total);
    $('kpiNuevas').textContent = `${n(data.hoy)} · ${n(data.semana)}`;
    $('kpiRecargas').textContent = n(data.recargas);
    $('kpiFichas').textContent = n(data.fichas);
    $('notaRecargas').textContent = `Recargas entregadas desde que se guardan en Supabase; ${n(data.recargas_con_cuenta)} fueron con la sesión iniciada. ${n(data.con_telefono)} de ${n(data.total)} cuentas dejaron su WhatsApp.`;
    cuentas = Array.isArray(data.cuentas) ? data.cuentas : [];
    pintarCuentas();
  }
  $('limiteCuentas').addEventListener('change', cargarCuentas);
  $('buscarCuenta').addEventListener('input', pintarCuentas);

  // ---------------------------------------------------------------- creadores (códigos de descuento)
  // Todo pasa por funciones de supabase/codigos.sql (admin_codigos, admin_codigo_guardar, admin_codigo_pagar,
  // admin_codigo_borrar, admin_tasa_guardar): la base revisa que seas administrador y que los datos sean válidos.
  let codigos = [];
  const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Errores que la base escribe para ti (código vacío, PIN corto, ya existe…); los demás, genéricos
  const ERRORES_PROPIOS = ['22023', '23505', '23503', 'P0002'];
  const textoError = (error, otro) => (error && ERRORES_PROPIOS.includes(error.code) ? error.message : otro);

  // "0414-1234567", "4141234567", "+58 414…" -> "+584141234567" (o null si no es un celular)
  function telefonoDe(texto) {
    let d = String(texto || '').replace(/\D/g, '');
    if (d.startsWith('58')) d = d.slice(2);
    if (d.startsWith('0')) d = d.slice(1);
    return /^4(12|14|16|22|24|26)\d{7}$/.test(d) ? '+58' + d : null;
  }

  const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  // Bancos de Pago Móvil (igual que api/creadores.js)
  const BANCOS = {
    '0102': 'Venezuela', '0104': 'Venezolano de Crédito', '0105': 'Mercantil', '0108': 'Provincial', '0114': 'Bancaribe',
    '0115': 'Exterior', '0128': 'Caroní', '0134': 'Banesco', '0137': 'Sofitasa', '0138': 'Plaza', '0146': 'Bangente',
    '0151': 'BFC', '0156': '100% Banco', '0157': 'DelSur', '0163': 'Tesoro', '0166': 'Agrícola', '0168': 'Bancrecer',
    '0169': 'R4', '0171': 'Activo', '0172': 'Bancamiga', '0173': 'BID', '0174': 'Banplus', '0175': 'Digital de los Trabajadores',
    '0177': 'Banfanb', '0178': 'N58', '0191': 'BNC',
  };
  const telCorto = (t) => String(t || '').replace(/^\+58(\d{3})(\d{7})$/, '0$1-$2');
  // "💵 Bolívares · Pago Móvil 0134 Banesco · V-12345678 · 0414-1234567" (para ver y para pagar)
  function textoCobro(f) {
    const pm = `Pago Móvil ${f.pm_banco} ${BANCOS[f.pm_banco] || ''} · ${String(f.pm_cedula).replace(/^([VE])/, '$1-')} · ${telCorto(f.pm_telefono)}`;
    return f.preferencia === 'diamantes' ? `💎 Diamantes · ID Free Fire ${f.id_jugador} (o ${pm})` : `💵 Bolívares · ${pm}`;
  }
  function mensajeCreador(codigo, pin, correo) {
    return `¡Hola! Tu código de Level Up es *${codigo}*. Quien recargue con él paga 1,5 % menos y tú ganas el 1,5 % de cada recarga.`
      + (correo ? ` Mira tus ganancias en ${location.origin}/creadores.html tocando "Entrar con Google" con tu correo ${correo}.`
        : ` Para ver tus ganancias mándanos tu correo de Gmail y te damos acceso a ${location.origin}/creadores.html.`);
  }

  async function cargarCodigos() {
    const { data, error } = await cliente.rpc('admin_codigos');
    if (error || !data) {
      console.error(error);
      $('listaCodigos').replaceChildren(el('li', 'vacio', 'No se pudieron cargar los códigos. ¿Ya corriste supabase/codigos.sql?'));
      return;
    }
    $('kpiCodigos').textContent = `${data.activos} de ${data.total}`;
    $('kpiUsosCodigos').textContent = Number(data.usos || 0).toLocaleString('es-VE');
    $('kpiDebes').textContent = usd(data.pendiente_usd);
    $('kpiPagado').textContent = usd(data.pagado_usd);
    if (document.activeElement !== $('tasaCreadores')) $('tasaCreadores').value = data.tasa ? String(Number(data.tasa)) : '';
    $('notaCreadores').textContent = data.tasa
      ? `Tasa guardada: ${bs(data.tasa)} Bs por dólar. Cada venta con código le da al creador el 1,5 % en dólares con la tasa de ese día. Actualízala cuando cambie.`
      : '⚠️ Falta la tasa del dólar: sin ella, las ganancias nuevas de los creadores esperan en bolívares. Escríbela y dale a Guardar.';
    if (Number(data.por_convertir_bs) > 0 && data.tasa) $('notaCreadores').textContent += ` Hay ${bs(data.por_convertir_bs)} Bs por pasar a dólares: se pasan al guardar la tasa.`;
    codigos = Array.isArray(data.codigos) ? data.codigos : [];
    pintarCodigos();
  }

  function pintarCodigos() {
    const texto = $('buscarCodigo').value.trim().toLowerCase();
    const filtro = $('filtroCodigos').value;
    const lista = $('listaCodigos');
    lista.replaceChildren();
    const visibles = codigos.filter((c) => (!texto || `${c.codigo} ${c.creador || ''}`.toLowerCase().includes(texto))
      && (filtro !== 'debe' || Number(c.pendiente_usd) > 0)
      && (filtro !== 'activos' || c.activo) && (filtro !== 'inactivos' || !c.activo));
    if (!visibles.length) { lista.append(el('li', 'vacio', 'No hay códigos con ese filtro.')); return; }
    visibles.forEach((c) => lista.append(tarjetaCodigo(c)));
  }

  function boton(texto, clase, alHacerClic) {
    const b = el('button', clase, texto);
    b.type = 'button';
    b.addEventListener('click', () => alHacerClic(b));
    return b;
  }

  function tarjetaCodigo(c) {
    const li = el('li', 'pedido codigo' + (c.activo ? '' : ' codigo--inactivo'));
    const cabeza = el('div', 'pedido-cabeza');
    cabeza.append(el('strong', 'codigo-nombre', c.codigo),
      el('span', 'etiqueta ' + (c.activo ? 'etiqueta--completado' : 'etiqueta--reembolsado'), c.activo ? 'Activo' : 'Desactivado'));
    const debe = Number(c.pendiente_usd) || 0;
    li.append(cabeza,
      el('span', '', c.creador ? `Creador: ${c.creador}` : `Promo de ${bs(c.descuento).replace(/,00$/, '')} % (sin creador)`),
      el('span', '', `${Number(c.usos).toLocaleString('es-VE')} ventas · ${bs(c.ventas_bs)} Bs movidos con su código`));
    if (c.creador) {
      const plata = el('span', 'codigo-plata');
      plata.append(el('span', '', `Ganado ${usd(c.comision_usd)}`), el('strong', debe > 0 ? 'codigo-debe' : '', debe > 0 ? `Le debes ${usd(debe)}` : 'No le debes nada'));
      if (Number(c.pagado_usd) > 0) plata.append(el('span', '', `Pagado ${usd(c.pagado_usd)}${c.ultimo_pago ? ' (último ' + corta(c.ultimo_pago) + ')' : ''}`));
      li.append(plata);
      if (c.correo) li.append(el('span', 'codigo-acceso', `Entra a su panel con Google: ${c.correo}${c.correo_entro ? ' ✓ ya entró' : ' (todavía no ha entrado)'}`));
      if (c.perfil) {
        const pago = el('div', 'codigo-pago');
        pago.append(el('strong', '', textoCobro(c.perfil)), el('span', '', `${c.perfil.edad} años · WhatsApp ${telCorto(c.perfil.telefono)}`));
        li.append(pago);
      } else if (c.correo) li.append(el('span', 'sin-telefono', 'Todavía no llenó sus datos de pago (se le piden al entrar).'));
      else li.append(el('span', 'sin-telefono', 'No puede ver su panel: pídele su Gmail y ponlo en Editar.'));
    }

    const acciones = el('div', 'acciones-cuenta');
    const tel = (c.perfil && c.perfil.telefono) || telefonoDe(c.creador);
    if (tel) acciones.append(enlaceWhatsapp(tel, mensajeCreador(c.codigo, '', c.correo)));
    if (debe > 0) acciones.append(boton(`Ya le pagué ${usd(debe)}`, 'btn-ver btn-pagar', (b) => pagarCodigo(c, b)));
    if (Number(c.usos) > 0) acciones.append(boton('Ver ventas', 'btn-ver', (b) => verVentasCodigo(c.codigo, li, b)));
    acciones.append(boton('Editar', 'btn-ver', () => editarCodigo(c, li)));
    acciones.append(boton(c.activo ? 'Desactivar' : 'Activar', 'btn-ver', (b) => cambiarActivo(c, b)));
    if (Number(c.usos) === 0 && Number(c.comision_usd) === 0 && Number(c.pagado_usd) === 0) {
      acciones.append(boton('Eliminar', 'btn-ver btn-ver--peligro', (b) => borrarCodigo(c, b)));
    }
    li.append(acciones);
    return li;
  }

  async function guardarCodigo(c, cambios) {
    return cliente.rpc('admin_codigo_guardar', {
      p_codigo: c.codigo, p_creador: 'creador' in cambios ? cambios.creador : (c.creador || ''),
      p_pin: cambios.pin || null, p_descuento: c.descuento === null ? null : Number(c.descuento),
      p_activo: 'activo' in cambios ? cambios.activo : c.activo, p_nuevo: false,
      p_correo: 'correo' in cambios ? cambios.correo : (c.correo || ''),
    });
  }

  async function cambiarActivo(c, b) {
    if (c.activo && !confirm(`¿Desactivar ${c.codigo}?\n\nLos clientes ya no podrán usarlo. Lo que ganó el creador se queda guardado y puedes activarlo cuando quieras.`)) return;
    b.disabled = true;
    const { error } = await guardarCodigo(c, { activo: !c.activo });
    if (error) { alert(textoError(error, 'No se pudo cambiar. Intenta de nuevo.')); b.disabled = false; return; }
    cargarCodigos();
  }

  async function pagarCodigo(c, b) {
    const como = c.perfil ? `\n\nCómo cobra: ${textoCobro(c.perfil)}` : '';
    if (!confirm(`¿Ya le pagaste ${usd(c.pendiente_usd)} a ${c.creador} (${c.codigo})?${como}\n\nLo que le debes vuelve a $0.00 y el pago queda anotado. Lo que ya ganó y sus ventas no cambian.`)) return;
    b.disabled = true;
    const { data, error } = await cliente.rpc('admin_codigo_pagar', { p_codigo: c.codigo });
    if (error) { alert(textoError(error, 'No se pudo anotar el pago. Intenta de nuevo.')); b.disabled = false; return; }
    alert(`✅ Pago de ${usd(data)} anotado a ${c.codigo}.`);
    cargarCodigos();
  }

  async function borrarCodigo(c, b) {
    if (!confirm(`¿Eliminar ${c.codigo}? Nunca se ha usado, así que no se pierde nada.`)) return;
    b.disabled = true;
    const { error } = await cliente.rpc('admin_codigo_borrar', { p_codigo: c.codigo });
    if (error) { alert(textoError(error, 'No se pudo eliminar. Intenta de nuevo.')); b.disabled = false; return; }
    cargarCodigos();
  }

  // Formulario para cambiar el creador o el PIN, debajo de la tarjeta
  function editarCodigo(c, li) {
    const abierto = li.querySelector('.editar-codigo');
    if (abierto) { abierto.remove(); return; }
    const form = el('form', 'formulario editar-codigo');
    form.noValidate = true;
    const campoCreador = el('label', 'campo', c.creador ? 'Creador (nombre o WhatsApp)' : 'Creador (vacío = promo)');
    const inCreador = el('input'); inCreador.type = 'text'; inCreador.maxLength = 60; inCreador.value = c.creador || '';
    campoCreador.append(inCreador);
    const campoCorreo = el('label', 'campo', 'Correo de Google del creador (para entrar a su panel; vacío = sin acceso)');
    const inCorreo = el('input'); inCorreo.type = 'email'; inCorreo.maxLength = 120; inCorreo.autocomplete = 'off'; inCorreo.value = c.correo || '';
    inCorreo.placeholder = 'Ej. carlos@gmail.com';
    campoCorreo.append(inCorreo);
    campoCorreo.hidden = !c.creador;
    inCreador.addEventListener('input', () => { campoCorreo.hidden = !inCreador.value.trim(); });
    const campoPin = el('label', 'campo', c.tiene_pin ? 'PIN nuevo, solo para identificarlo (vacío = no cambiarlo)' : 'PIN, solo para identificarlo (opcional, 4 a 8 números)');
    const inPin = el('input'); inPin.type = 'text'; inPin.inputMode = 'numeric'; inPin.maxLength = 8; inPin.autocomplete = 'off';
    campoPin.append(inPin);
    const mensaje = el('p', 'mensaje-form'); mensaje.setAttribute('role', 'status');
    const guardar = el('button', 'btn btn--chico', 'Guardar cambios'); guardar.type = 'submit';
    form.append(campoCreador, campoCorreo, campoPin, guardar, mensaje);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const pin = inPin.value.trim();
      if (pin && !/^\d{4,8}$/.test(pin)) { mensaje.textContent = 'El PIN debe tener de 4 a 8 números.'; return; }
      if (!inCreador.value.trim() && c.descuento === null) { mensaje.textContent = 'Escribe el creador (un código sin creador necesita un % de promo).'; return; }
      const correo = inCreador.value.trim() ? inCorreo.value.trim().toLowerCase() : '';
      if (correo && !CORREO.test(correo)) { mensaje.textContent = 'Ese correo no es válido. Ejemplo: carlos@gmail.com'; return; }
      guardar.disabled = true;
      const { error } = await guardarCodigo(c, { creador: inCreador.value.trim(), pin, correo });
      guardar.disabled = false;
      if (error) { mensaje.textContent = textoError(error, 'No se pudo guardar. Intenta de nuevo.'); return; }
      const correoNuevo = correo && correo !== (c.correo || '');
      mensaje.textContent = correoNuevo ? `✅ Guardado. ${correo} ya puede entrar a su panel con Google.` : pin ? `✅ Guardado. Nuevo PIN: ${pin}` : '✅ Guardado.';
      const tel = telefonoDe(inCreador.value);
      const avisar = correoNuevo && tel;
      if (avisar) form.append(enlaceWhatsapp(tel, mensajeCreador(c.codigo, pin, correo)));
      setTimeout(cargarCodigos, avisar ? 8000 : 1200);
    });
    li.append(form);
    inCreador.focus();
  }

  // Últimas 20 ventas con este código (los pedidos guardan el código desde el 13/11/2026)
  async function verVentasCodigo(codigo, li, b) {
    const abierta = li.querySelector('.recargas-cuenta');
    if (abierta) { abierta.remove(); b.textContent = 'Ver ventas'; return; }
    b.disabled = true;
    const { data, error } = await cliente.from('recargas')
      .select('id_pedido,juego,cuenta,paquete,precio,referencia,estado,creado,usuario')
      .eq('codigo_descuento', codigo).order('creado', { ascending: false }).limit(20);
    b.disabled = false;
    const sub = el('ul', 'pedidos recargas-cuenta');
    if (error) sub.append(el('li', 'vacio', 'No se pudieron cargar.'));
    else if (!data || !data.length) sub.append(el('li', 'vacio', 'Sus ventas anteriores al 13/11/2026 están en la hoja (movimientos_descuentos).'));
    else data.forEach((p) => sub.append(tarjetaPedido(p, false)));
    li.append(sub);
    b.textContent = 'Ocultar ventas';
  }

  // Crear código
  $('nuevoTipo').addEventListener('change', () => {
    const promo = $('nuevoTipo').value === 'promo';
    $('campoCreador').hidden = promo;
    $('campoPin').hidden = promo;
    $('campoCorreo').hidden = promo;
    $('campoDescuento').hidden = !promo;
  });
  $('nuevoCodigo').addEventListener('input', () => {
    const limpio = $('nuevoCodigo').value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (limpio !== $('nuevoCodigo').value) $('nuevoCodigo').value = limpio;
  });
  $('generarPin').addEventListener('click', () => {
    const n = new Uint32Array(1);
    crypto.getRandomValues(n);
    $('nuevoPin').value = String(1000 + (n[0] % 9000));
  });
  $('formCodigo').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('mensajeCodigo');
    const promo = $('nuevoTipo').value === 'promo';
    const codigo = $('nuevoCodigo').value.trim().toUpperCase();
    const creador = promo ? '' : $('nuevoCreador').value.trim();
    const pin = promo ? '' : $('nuevoPin').value.trim();
    const correo = promo ? '' : $('nuevoCorreo').value.trim().toLowerCase();
    const descuento = promo ? Number($('nuevoDescuento').value) : null;
    msg.replaceChildren();
    if (!/^[A-Z0-9_-]{2,30}$/.test(codigo)) { msg.textContent = 'Escribe el código: de 2 a 30 letras o números, sin espacios.'; return; }
    if (!promo && !creador) { msg.textContent = 'Escribe el nombre o el WhatsApp del creador.'; return; }
    if (correo && !CORREO.test(correo)) { msg.textContent = 'Ese correo no es válido. Ejemplo: carlos@gmail.com'; return; }
    if (pin && !/^\d{4,8}$/.test(pin)) { msg.textContent = 'El PIN debe tener de 4 a 8 números.'; return; }
    if (promo && !(descuento > 0 && descuento < 100)) { msg.textContent = 'Escribe el % de descuento de la promo (por ejemplo 5).'; return; }
    $('btnCrearCodigo').disabled = true;
    const { error } = await cliente.rpc('admin_codigo_guardar', {
      p_codigo: codigo, p_creador: creador, p_pin: pin || null, p_descuento: descuento, p_activo: true, p_nuevo: true,
      p_correo: correo,
    });
    $('btnCrearCodigo').disabled = false;
    if (error) { msg.textContent = textoError(error, 'No se pudo crear. Intenta de nuevo.'); return; }
    msg.textContent = promo ? `✅ ${codigo} creado: ya funciona en todas las tiendas.`
      : `✅ ${codigo} creado${correo ? ` (entra a su panel con Google: ${correo})` : ' (sin correo: todavía no puede ver su panel)'}: ya funciona en todas las tiendas. Mándale sus datos al creador:`;
    const tel = telefonoDe(creador);
    if (tel) msg.append(' ', enlaceWhatsapp(tel, mensajeCreador(codigo, pin, correo)));
    else if (!promo) msg.append(el('span', 'texto-copiar', ' ' + mensajeCreador(codigo, pin, correo)));
    $('formCodigo').reset();
    $('nuevoTipo').dispatchEvent(new Event('change'));
    cargarCodigos();
  });

  $('formTasa').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const tasa = Number($('tasaCreadores').value);
    if (!(tasa > 0)) { $('notaCreadores').textContent = 'Escribe la tasa: cuántos bolívares vale un dólar.'; return; }
    const { error } = await cliente.rpc('admin_tasa_guardar', { p_tasa: tasa });
    if (error) { $('notaCreadores').textContent = textoError(error, 'No se pudo guardar la tasa. Intenta de nuevo.'); return; }
    $('tasaCreadores').blur();
    cargarCodigos();
  });
  $('buscarCodigo').addEventListener('input', pintarCodigos);
  $('filtroCodigos').addEventListener('change', pintarCodigos);

  // ---------------------------------------------------------------- precios (supabase/precios.sql)
  // Precio de un paquete: el manual o costo de Central One × cantidad × dólar × (1 + ganancia %). La base
  // calcula (precios_de) y valida; aquí solo se muestra y se edita. "Traer productos" va por Vercel porque
  // necesita la llave de Central One (api/_lib/precios.js).
  let preciosDatos = null;
  const usd4 = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const hace = (iso) => {
    if (!iso) return 'nunca';
    const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return min < 1 ? 'hace un momento' : min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} días`;
  };

  async function cargarPrecios() {
    const juego = $('juegoPrecios').value;
    // Las tiendas manuales no usan Central One: solo paquetes con precio a mano
    $('filaTraerProductos').hidden = MANUALES.has(juego);
    const { data, error } = await cliente.rpc('admin_precios', { p_juego: juego });
    if (error || !data) {
      console.error(error);
      $('listaPrecios').replaceChildren(el('li', 'vacio', 'No se pudieron cargar. ¿Ya corriste supabase/precios.sql?'));
      return;
    }
    preciosDatos = data;
    if (document.activeElement !== $('costoPartida')) $('costoPartida').value = data.costo_partida || '';
    if (document.activeElement !== $('bsPorFicha')) $('bsPorFicha').value = data.bs_por_ficha ? String(Number(data.bs_por_ficha)) : '';
    pintarDiferencias(data.diferencias || []);
    pintarCambios(data.cambios || []);
    if (document.activeElement !== $('tasaPrecios')) $('tasaPrecios').value = data.tasa ? String(Number(data.tasa)) : '';
    if (document.activeElement !== $('gananciaPrecios')) $('gananciaPrecios').value = data.ganancia !== null ? String(Number(data.ganancia)) : '';
    const falta = [!data.tasa && 'el dólar', data.ganancia === null && 'la ganancia'].filter(Boolean);
    $('notaPrecios').textContent = falta.length
      ? `⚠️ Falta ${falta.join(' y ')}: sin eso, los paquetes sin precio a mano no tienen precio.`
      : `Dólar ${bs(data.tasa)} Bs · ganancia ${Number(data.ganancia).toLocaleString('es-VE')} %. Todo paquete sin precio a mano = costo de Central One × ${bs(data.tasa)} × ${(1 + Number(data.ganancia) / 100).toLocaleString('es-VE', { maximumFractionDigits: 4 })}.`;
    const vistos = (data.paquetes || []).map((p) => p.visto).filter(Boolean).sort();
    $('estadoCatalogo').textContent = vistos.length ? `Costos de Central One leídos ${hace(vistos[vistos.length - 1])}.` : '';
    pintarPrecios();
  }

  function pintarPrecios() {
    const d = preciosDatos;
    const lista = $('listaPrecios');
    lista.replaceChildren();
    const paquetes = d.paquetes || [];
    if (!paquetes.length) lista.append(el('li', 'vacio', 'Este juego todavía no tiene paquetes. Trae los productos de Central One y agrégalos.'));
    paquetes.forEach((p, i) => lista.append(tarjetaPrecio(p, i, paquetes.length)));

    const sinUsar = $('listaSinUsar');
    sinUsar.replaceChildren();
    if (!(d.sin_usar || []).length) sinUsar.append(el('li', 'vacio', 'Nada pendiente. Toca "Traer productos" para ver lo nuevo de Central One.'));
    (d.sin_usar || []).forEach((c) => {
      const li = el('li', 'pedido');
      const fila = el('div', 'borrar-fila');
      const texto = el('div');
      texto.append(el('strong', '', c.nombre || c.producto),
        el('span', 'precio-detalle', `${c.region || ''} · costo ${usd4(c.costo_usd)}${d.tasa ? ` (${bs(c.costo_usd * d.tasa)} Bs)` : ''}${c.en_stock ? '' : ' · sin stock'}`));
      fila.append(texto, boton('Agregar', 'btn-ver', (b) => agregarProducto(c, b)));
      li.append(fila);
      sinUsar.append(li);
    });
  }

  function tarjetaPrecio(p, i, total) {
    const d = preciosDatos;
    const li = el('li', 'pedido' + (p.activo ? '' : ' codigo--inactivo'));
    const cabeza = el('div', 'pedido-cabeza');
    const etiquetas = el('span', 'etiquetas');
    etiquetas.append(el('span', 'etiqueta ' + (p.precio_manual !== null ? 'etiqueta--pendiente' : 'etiqueta--completado'), p.precio_manual !== null ? 'A mano' : 'Automático'));
    if (!p.en_stock) etiquetas.append(el('span', 'etiqueta etiqueta--problema', 'Sin stock'));
    if (!p.activo) etiquetas.append(el('span', 'etiqueta etiqueta--reembolsado', 'Oculto'));
    cabeza.append(el('strong', '', p.paquete + (p.cantidad > 1 ? ` (×${p.cantidad})` : '')), etiquetas);
    li.append(cabeza);
    li.append(el('span', 'precio-final', p.precio !== null ? `${bs(p.precio)} Bs` : 'Sin precio (falta dólar, ganancia o costo)'));
    if (p.costo_usd !== null && d.tasa) {
      const costoBs = Number(p.costo_usd) * p.cantidad * Number(d.tasa);
      const linea = el('span', 'precio-detalle', `Te cuesta ${usd4(p.costo_usd)}${p.cantidad > 1 ? ` ×${p.cantidad}` : ''} = ${bs(costoBs)} Bs`);
      if (p.precio !== null) {
        const gana = Number(p.precio) - costoBs;
        linea.append(document.createTextNode(' · '),
          el('strong', gana < 0 ? 'pierdes' : 'ganas', gana < 0 ? `¡pierdes ${bs(-gana)} Bs!` : `ganas ${bs(gana)} Bs (${Math.round((gana / costoBs) * 1000) / 10} %)`));
      }
      li.append(linea);
      if (p.precio_manual !== null && p.precio_calculado !== null) li.append(el('span', 'precio-detalle', `Automático sería ${bs(p.precio_calculado)} Bs.`));
    } else if (p.producto) li.append(el('span', 'precio-detalle', 'Sin costo de Central One todavía: toca "Traer productos".'));
    else li.append(el('span', 'precio-detalle', 'Lo entregas tú (sin Central One).'));
    li.append(el('span', 'precio-detalle precio-fichas', p.fichas_manual !== null
      ? (p.fichas_manual === 0 ? '🎟️ No da fichas (a mano)' : `🎟️ Da ${p.fichas_manual} ficha${p.fichas_manual === 1 ? '' : 's'} (a mano)`)
      : p.fichas ? `🎟️ Da ${p.fichas} ficha${p.fichas === 1 ? '' : 's'} (según el precio)` : '🎟️ Sin fichas (sin precio)'));

    const acciones = el('div', 'acciones-cuenta');
    const subir = boton('↑', 'btn-ver btn-mini', (b) => moverPrecio(p.id, -1, b)); subir.disabled = i === 0; subir.setAttribute('aria-label', 'Subir');
    const bajar = boton('↓', 'btn-ver btn-mini', (b) => moverPrecio(p.id, 1, b)); bajar.disabled = i === total - 1; bajar.setAttribute('aria-label', 'Bajar');
    acciones.append(subir, bajar,
      boton('Editar', 'btn-ver', () => editarPrecio(p, li)),
      boton(p.activo ? 'Ocultar' : 'Mostrar', 'btn-ver', (b) => guardarPrecio(p, { activo: !p.activo }, b)),
      boton('Quitar', 'btn-ver btn-ver--peligro', (b) => quitarPrecio(p, b)));
    li.append(acciones);
    return li;
  }

  async function guardarPrecio(p, cambios, b) {
    if (b) b.disabled = true;
    const v = Object.assign({ paquete: p.paquete, cantidad: p.cantidad, precio_manual: p.precio_manual, activo: p.activo }, cambios);
    const { error } = await cliente.rpc('admin_precio_guardar', {
      p_id: p.id, p_juego: $('juegoPrecios').value, p_paquete: v.paquete, p_producto: p.producto || '',
      p_cantidad: Number(v.cantidad), p_precio_manual: v.precio_manual === null || v.precio_manual === '' ? null : Number(v.precio_manual),
      p_activo: v.activo, p_orden: null,
    });
    if (error) { if (b) b.disabled = false; return textoError(error, 'No se pudo guardar. Intenta de nuevo.'); }
    cargarPrecios();
    return '';
  }

  function editarPrecio(p, li) {
    const abierto = li.querySelector('.editar-codigo');
    if (abierto) { abierto.remove(); return; }
    const form = el('form', 'formulario editar-codigo');
    form.noValidate = true;
    const campo = (texto, input) => { const l = el('label', 'campo', texto); l.append(input); return l; };
    const inNombre = el('input'); inNombre.type = 'text'; inNombre.maxLength = 80; inNombre.value = p.paquete;
    const inPrecio = el('input'); inPrecio.type = 'number'; inPrecio.inputMode = 'decimal'; inPrecio.min = '0'; inPrecio.step = '0.01';
    inPrecio.value = p.precio_manual !== null ? String(Number(p.precio_manual)) : '';
    inPrecio.placeholder = p.producto ? 'Vacío = automático' : 'Precio en Bs';
    const inCantidad = el('input'); inCantidad.type = 'number'; inCantidad.min = '1'; inCantidad.max = '10'; inCantidad.value = String(p.cantidad);
    const inFichas = el('input'); inFichas.type = 'number'; inFichas.inputMode = 'numeric'; inFichas.min = '0'; inFichas.max = '1000'; inFichas.step = '1';
    inFichas.value = p.fichas_manual !== null ? String(p.fichas_manual) : '';
    inFichas.placeholder = p.fichas ? `Vacío = ${p.fichas} según el precio` : 'Vacío = según el precio';
    const mensaje = el('p', 'mensaje-form'); mensaje.setAttribute('role', 'status');
    const guardar = el('button', 'btn btn--chico', 'Guardar'); guardar.type = 'submit';
    const filas = el('div', 'dos-campos');
    filas.append(campo('Nombre que ve el cliente', inNombre), campo(p.producto ? 'Precio a mano (Bs) · vacío = automático' : 'Precio (Bs)', inPrecio));
    form.append(filas);
    if (p.producto) form.append(campo('Cantidad (cuántos de ese producto se compran)', inCantidad));
    form.append(campo('Fichas del minijuego que da (vacío = según el precio · 0 = no da)', inFichas));
    form.append(guardar, mensaje);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const precio = inPrecio.value.trim();
      if (precio && !(Number(precio) > 0)) { mensaje.textContent = 'El precio tiene que ser mayor que 0.'; return; }
      const fichas = inFichas.value.trim();
      if (fichas !== '' && !(Number.isInteger(Number(fichas)) && Number(fichas) >= 0 && Number(fichas) <= 1000)) { mensaje.textContent = 'Las fichas van de 0 a 1000 (o vacío).'; return; }
      guardar.disabled = true;
      const nuevasFichas = fichas === '' ? null : Number(fichas);
      if (nuevasFichas !== p.fichas_manual) {
        const { error: e } = await cliente.rpc('admin_precio_fichas', { p_id: p.id, p_fichas: nuevasFichas });
        if (e) { guardar.disabled = false; mensaje.textContent = textoError(e, 'No se pudieron guardar las fichas.'); return; }
      }
      const fallo = await guardarPrecio(p, { paquete: inNombre.value.trim(), precio_manual: precio === '' ? null : precio, cantidad: inCantidad.value });
      guardar.disabled = false;
      if (fallo) mensaje.textContent = fallo;
    });
    li.append(form);
    inPrecio.focus();
  }

  async function moverPrecio(id, paso, b) {
    b.disabled = true;
    const { error } = await cliente.rpc('admin_precio_mover', { p_id: id, p_paso: paso });
    if (error) console.error(error);
    cargarPrecios();
  }

  async function quitarPrecio(p, b) {
    if (!confirm(`¿Quitar "${p.paquete}" de la lista de ${$('juegoPrecios').selectedOptions[0].textContent}?\n\nSi solo quieres que no se venda un tiempo, mejor usa "Ocultar".`)) return;
    b.disabled = true;
    const { error } = await cliente.rpc('admin_precio_borrar', { p_id: p.id });
    if (error) { alert(textoError(error, 'No se pudo quitar.')); b.disabled = false; return; }
    cargarPrecios();
  }

  async function agregarProducto(c, b) {
    b.disabled = true;
    const { error } = await cliente.rpc('admin_precio_guardar', {
      p_id: null, p_juego: $('juegoPrecios').value, p_paquete: String(c.nombre || 'Paquete').slice(0, 80), p_producto: c.producto,
      p_cantidad: 1, p_precio_manual: null, p_activo: true, p_orden: null,
    });
    if (error) { alert(textoError(error, 'No se pudo agregar.')); b.disabled = false; return; }
    cargarPrecios();
  }

  $('btnTraerProductos').addEventListener('click', async () => {
    const b = $('btnTraerProductos');
    const juego = $('juegoPrecios').value;
    b.disabled = true;
    $('estadoCatalogo').textContent = 'Preguntando a Central One…';
    try {
      const { data: s } = await cliente.auth.getSession();
      const res = await fetch(`/api/juego?juego=${juego}&accion=traer_productos`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + ((s && s.session && s.session.access_token) || '') },
      });
      const r = await res.json();
      $('estadoCatalogo').textContent = r.status === 'success'
        ? `✅ Central One tiene ${r.total} productos de este juego (${r.conStock} con stock). Costos y stock actualizados.`
        : (r.message || 'No se pudo traer el catálogo.');
      if (r.status === 'success') await cargarPrecios();
    } catch (e) {
      $('estadoCatalogo').textContent = 'No se pudo conectar. Intenta de nuevo.';
    } finally {
      b.disabled = false;
    }
  });

  $('juegoPrecios').addEventListener('change', cargarPrecios);

  // Avisos de Central One de este juego (centralone_cambios): se agotó, volvió, cambió el costo
  function pintarCambios(lista) {
    const ul = $('listaCambios');
    ul.replaceChildren();
    if (!lista.length) { ul.append(el('li', 'vacio', 'Sin avisos de Central One en los últimos 7 días (o todavía no están activados).')); return; }
    const TEXTO = { agotado: ['Se agotó', 'etiqueta--problema'], fuera: ['Salió del catálogo', 'etiqueta--problema'], repuesto: ['Volvió el stock', 'etiqueta--completado'], dentro: ['Entró al catálogo', 'etiqueta--completado'], precio: ['Cambió el costo', 'etiqueta--en_revision'] };
    lista.forEach((c) => {
      const [texto, clase] = TEXTO[c.tipo] || [c.tipo, ''];
      const li = el('li', 'pedido');
      const cabeza = el('div', 'pedido-cabeza');
      cabeza.append(el('strong', '', c.nombre || 'Producto'), el('span', 'etiqueta ' + clase, texto));
      li.append(cabeza, el('span', 'precio-detalle', `${fecha(c.fecha)}${c.tipo === 'precio' ? ` · $${Number(c.antes)} → $${Number(c.despues)}` : ''}`));
      ul.append(li);
    });
  }

  // Prueba en paralelo: lo que la hoja cobra distinto de Supabase (precios_diferencias)
  function pintarDiferencias(lista) {
    const ul = $('listaDiferencias');
    if (!ul) return;   // la prueba en paralelo terminó: la tienda ya cobra con Supabase
    ul.replaceChildren();
    if (!lista.length) { ul.append(el('li', 'vacio', '✅ Sin diferencias en este juego (o todavía nadie abrió la tienda desde el último cambio).')); return; }
    lista.forEach((d) => {
      const li = el('li', 'pedido');
      const cabeza = el('div', 'pedido-cabeza');
      cabeza.append(el('strong', '', d.paquete), el('span', 'etiqueta etiqueta--en_revision', 'Diferente'));
      const texto = d.precio_hoja === null ? `No está en la hoja. Aquí: ${bs(d.precio_supabase)} Bs`
        : d.precio_supabase === null ? `Hoja: ${bs(d.precio_hoja)} Bs. Aquí no está (o no tiene precio)`
        : `Hoja: ${bs(d.precio_hoja)} Bs · aquí: ${bs(d.precio_supabase)} Bs (${d.precio_supabase > d.precio_hoja ? '+' : ''}${bs(d.precio_supabase - d.precio_hoja)})`;
      li.append(cabeza, el('span', '', texto), el('span', 'precio-detalle', `Visto ${hace(d.visto)}`));
      ul.append(li);
    });
  }

  $('formCostoPartida').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const costo = Number($('costoPartida').value);
    if (!(Number.isInteger(costo) && costo >= 1)) return;
    const { error } = await cliente.rpc('admin_juego_ajustes', { p_costo: costo, p_bs_por_ficha: Number(preciosDatos && preciosDatos.bs_por_ficha) || Number($('bsPorFicha').value) });
    if (error) { alert(textoError(error, 'No se pudo guardar.')); return; }
    $('costoPartida').blur();
    cargarPrecios();
  });
  $('formBsFicha').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const bsFicha = Number($('bsPorFicha').value);
    if (!(bsFicha > 0)) return;
    const { error } = await cliente.rpc('admin_juego_ajustes', { p_costo: Number(preciosDatos && preciosDatos.costo_partida) || Number($('costoPartida').value), p_bs_por_ficha: bsFicha });
    if (error) { alert(textoError(error, 'No se pudo guardar.')); return; }
    $('bsPorFicha').blur();
    cargarPrecios();
  });
  $('formTasaPrecios').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const tasa = Number($('tasaPrecios').value);
    const antes = preciosDatos && Number(preciosDatos.tasa);
    if (!(tasa > 0)) return;
    if (antes && Math.abs(tasa - antes) / antes > 0.1 && !confirm(`El dólar pasa de ${bs(antes)} a ${bs(tasa)} Bs (${Math.round(((tasa - antes) / antes) * 100)} %).\n\n¿Seguro? Cambia todos los precios automáticos.`)) return;
    const { error } = await cliente.rpc('admin_tasa_guardar', { p_tasa: tasa });
    if (error) { alert(textoError(error, 'No se pudo guardar el dólar.')); return; }
    $('tasaPrecios').blur();
    cargarPrecios();
  });
  $('formGanancia').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pct = Number($('gananciaPrecios').value);
    if (!(pct >= 0)) return;
    const { error } = await cliente.rpc('admin_ganancia_guardar', { p_pct: pct });
    if (error) { alert(textoError(error, 'No se pudo guardar la ganancia.')); return; }
    $('gananciaPrecios').blur();
    cargarPrecios();
  });
  $('formPaqueteManual').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nombre = $('manualNombre').value.trim();
    const precio = Number($('manualPrecio').value);
    if (!nombre || !(precio > 0)) { $('mensajeManual').textContent = 'Escribe el nombre y el precio.'; return; }
    const { error } = await cliente.rpc('admin_precio_guardar', {
      p_id: null, p_juego: $('juegoPrecios').value, p_paquete: nombre, p_producto: '', p_cantidad: 1,
      p_precio_manual: precio, p_activo: true, p_orden: null,
    });
    if (error) { $('mensajeManual').textContent = textoError(error, 'No se pudo agregar.'); return; }
    $('mensajeManual').textContent = `✅ ${nombre} agregado.`;
    $('formPaqueteManual').reset();
    cargarPrecios();
  });

  // ---------------------------------------------------------------- roblox (supabase/roblox.sql)
  // Los códigos son dinero: la base solo devuelve los últimos 4 caracteres (admin_roblox). Los paquetes y
  // sus precios son los de la tabla "precios" (juego "roblox"); los códigos se guardan por la clave del
  // paquete (los números de su nombre: "800 Robux" → "800"), igual que roblox.gs y api/_lib/juegos/roblox.js.
  const claveRoblox = (nombre) => {
    const n = String(nombre || '').replace(/[^0-9]/g, '');
    return n ? (/EE\.?\s*UU|ESTADOS\s+UNIDOS|UNITED\s+STATES|\bUSA?\b/i.test(String(nombre)) ? `${n}-EEUU` : n) : '';
  };
  let robloxPaquetes = [];
  async function cargarRoblox() {
    const [{ data, error }, precios] = await Promise.all([cliente.rpc('admin_roblox'), cliente.rpc('admin_precios', { p_juego: 'roblox' })]);
    if (error || !data) {
      console.error(error);
      $('listaRobloxLibres').replaceChildren(el('li', 'vacio', 'No se pudieron cargar. ¿Ya corriste supabase/roblox.sql?'));
      return;
    }
    $('robloxCentralOne').checked = data.central_one === true;
    const porPaquete = Object.fromEntries((data.paquetes || []).map((p) => [p.paquete, p]));
    robloxPaquetes = (precios.data && precios.data.paquetes) || [];
    preciosDatosRoblox = precios.data || {};
    pintarPaquetesRoblox(porPaquete, (precios.data && precios.data.sin_usar) || []);
    $('kpisRoblox').replaceChildren(...robloxPaquetes.map((p) => {
      const libres = Number((porPaquete[claveRoblox(p.paquete)] || {}).libres) || 0;
      const kpi = el('div', 'kpi' + (libres <= 3 ? ' kpi--aviso' : ''));
      kpi.append(el('small', '', p.paquete), el('strong', '', libres === 0 ? 'Agotado' : `${libres} libres`));
      return kpi;
    }));
    const elegido = $('robloxPaquete').value;
    $('robloxPaquete').replaceChildren(...robloxPaquetes.map((p) => {
      const o = el('option', '', p.paquete);
      o.value = claveRoblox(p.paquete);
      return o;
    }));
    if (elegido) $('robloxPaquete').value = elegido;

    const entregados = $('listaRobloxEntregados');
    entregados.replaceChildren();
    if (!(data.ultimos || []).length) entregados.append(el('li', 'vacio', 'Todavía no se ha entregado ningún código desde Supabase.'));
    (data.ultimos || []).forEach((c) => {
      const li = el('li', 'pedido');
      const cabeza = el('div', 'pedido-cabeza');
      cabeza.append(el('strong', '', `${c.paquete} Robux · …${c.fin}`), el('span', 'etiqueta etiqueta--completado', 'Entregado'));
      li.append(cabeza, el('span', '', `${c.usuario || 'sin usuario'} · ${c.entregado ? fecha(c.entregado) : ''} · ${c.id_pedido || ''}`));
      entregados.append(li);
    });

    const libres = $('listaRobloxLibres');
    libres.replaceChildren();
    if (!(data.libres || []).length) libres.append(el('li', 'vacio', 'No hay códigos sin entregar. Cárgalos arriba.'));
    (data.libres || []).forEach((c) => {
      const li = el('li', 'pedido');
      const fila = el('div', 'borrar-fila');
      const texto = el('div');
      texto.append(el('strong', '', `${c.paquete} Robux · …${c.fin}`), el('span', 'precio-detalle', `Cargado ${corta(c.cargado)}`));
      fila.append(texto, boton('Anular', 'btn-ver btn-ver--peligro', async (b) => {
        if (!confirm(`¿Anular el código …${c.fin} de ${c.paquete} Robux?\n\nYa no se le entregará a nadie. No se puede deshacer.`)) return;
        b.disabled = true;
        const { error: e } = await cliente.rpc('admin_roblox_anular', { p_id: c.id });
        if (e) { alert(textoError(e, 'No se pudo anular.')); b.disabled = false; return; }
        cargarRoblox();
      }));
      li.append(fila);
      libres.append(li);
    });
  }

  // Paquetes: precio, unión con Central One y crear nuevos (admin_precio_guardar de supabase/precios.sql)
  function opcionesCentralOne(select, sinUsar, actual) {
    const opciones = [el('option', '', 'Ninguno: solo mis códigos')];
    opciones[0].value = '';
    const lista = sinUsar.slice();
    if (actual && !lista.some((c) => c.producto === actual)) lista.unshift({ producto: actual, nombre: 'Producto actual', costo_usd: null });
    lista.forEach((c) => {
      const o = el('option', '', `${c.nombre || c.producto}${c.costo_usd !== null ? ` · $${Number(c.costo_usd)}` : ''}${c.en_stock === false ? ' · sin stock' : ''}`);
      o.value = c.producto;
      opciones.push(o);
    });
    select.replaceChildren(...opciones);
    select.value = actual || '';
  }

  function pintarPaquetesRoblox(porPaquete, sinUsar) {
    const lista = $('listaPaquetesRoblox');
    lista.replaceChildren();
    if (!robloxPaquetes.length) lista.append(el('li', 'vacio', 'No hay paquetes. Crea uno abajo.'));
    robloxPaquetes.forEach((p) => {
      const libres = Number((porPaquete[claveRoblox(p.paquete)] || {}).libres) || 0;
      const li = el('li', 'pedido' + (p.activo ? '' : ' codigo--inactivo'));
      const cabeza = el('div', 'pedido-cabeza');
      const etiquetas = el('span', 'etiquetas');
      etiquetas.append(el('span', 'etiqueta ' + (libres > 0 ? 'etiqueta--completado' : 'etiqueta--problema'), libres > 0 ? `${libres} códigos` : 'Sin códigos'));
      if (p.producto) etiquetas.append(el('span', 'etiqueta etiqueta--pendiente', 'Central One'));
      if (!p.activo) etiquetas.append(el('span', 'etiqueta etiqueta--reembolsado', 'Oculto'));
      cabeza.append(el('strong', '', p.paquete), etiquetas);
      li.append(cabeza, el('span', 'precio-final', p.precio !== null ? `${bs(p.precio)} Bs` : 'Sin precio'));
      if (p.producto && p.costo_usd !== null && preciosDatosRoblox.tasa) {
        const costoBs = Number(p.costo_usd) * Number(preciosDatosRoblox.tasa);
        li.append(el('span', 'precio-detalle', `En Central One te cuesta $${Number(p.costo_usd)} = ${bs(costoBs)} Bs${p.en_stock ? '' : ' · sin stock allí'}`));
      }
      const acciones = el('div', 'acciones-cuenta');
      acciones.append(
        boton('Editar', 'btn-ver', () => editarPaqueteRoblox(p, li, sinUsar)),
        boton(p.activo ? 'Ocultar' : 'Mostrar', 'btn-ver', (b) => guardarPaqueteRoblox(p, { activo: !p.activo }, b)));
      li.append(acciones);
      lista.append(li);
    });
    opcionesCentralOne($('nuevoRobloxProducto'), sinUsar, '');
  }
  let preciosDatosRoblox = {};

  async function guardarPaqueteRoblox(p, cambios, b) {
    if (b) b.disabled = true;
    const v = Object.assign({ paquete: p.paquete, precio_manual: p.precio_manual, producto: p.producto || '', activo: p.activo }, cambios);
    const { error } = await cliente.rpc('admin_precio_guardar', {
      p_id: p.id, p_juego: 'roblox', p_paquete: v.paquete, p_producto: v.producto, p_cantidad: 1,
      p_precio_manual: v.precio_manual === null || v.precio_manual === '' ? null : Number(v.precio_manual), p_activo: v.activo, p_orden: null,
    });
    if (error) { if (b) b.disabled = false; return textoError(error, 'No se pudo guardar.'); }
    cargarRoblox();
    return '';
  }

  function editarPaqueteRoblox(p, li, sinUsar) {
    const abierto = li.querySelector('.editar-codigo');
    if (abierto) { abierto.remove(); return; }
    const form = el('form', 'formulario editar-codigo');
    form.noValidate = true;
    const inPrecio = el('input'); inPrecio.type = 'number'; inPrecio.inputMode = 'decimal'; inPrecio.min = '0'; inPrecio.step = '0.01';
    inPrecio.value = p.precio_manual !== null ? String(Number(p.precio_manual)) : '';
    const selProducto = el('select');
    opcionesCentralOne(selProducto, sinUsar, p.producto || '');
    const campo = (texto, input) => { const l = el('label', 'campo', texto); l.append(input); return l; };
    const mensaje = el('p', 'mensaje-form'); mensaje.setAttribute('role', 'status');
    const guardar = el('button', 'btn btn--chico', 'Guardar'); guardar.type = 'submit';
    form.append(campo('Precio (Bs)', inPrecio), campo('Producto de Central One', selProducto), guardar, mensaje);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!(Number(inPrecio.value) > 0)) { mensaje.textContent = 'Escribe el precio en Bs.'; return; }
      guardar.disabled = true;
      const fallo = await guardarPaqueteRoblox(p, { precio_manual: inPrecio.value, producto: selProducto.value });
      guardar.disabled = false;
      if (fallo) mensaje.textContent = fallo;
    });
    li.append(form);
    inPrecio.focus();
  }

  $('formNuevoRoblox').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('mensajeNuevoRoblox');
    const nombre = $('nuevoRobloxNombre').value.trim();
    const precio = Number($('nuevoRobloxPrecio').value);
    if (!claveRoblox(nombre)) { msg.textContent = 'El nombre tiene que llevar los Robux, por ejemplo "800 Robux".'; return; }
    if (robloxPaquetes.some((p) => claveRoblox(p.paquete) === claveRoblox(nombre))) { msg.textContent = 'Ya hay un paquete con esos Robux.'; return; }
    if (!(precio > 0)) { msg.textContent = 'Escribe el precio en Bs.'; return; }
    const { error } = await cliente.rpc('admin_precio_guardar', {
      p_id: null, p_juego: 'roblox', p_paquete: nombre, p_producto: $('nuevoRobloxProducto').value, p_cantidad: 1,
      p_precio_manual: precio, p_activo: true, p_orden: null,
    });
    if (error) { msg.textContent = textoError(error, 'No se pudo crear.'); return; }
    msg.textContent = `✅ ${nombre} creado. Ahora cárgale códigos abajo (o activa Central One si lo uniste a un producto).`;
    $('formNuevoRoblox').reset();
    await cargarRoblox();
    $('robloxPaquete').value = claveRoblox(nombre);
  });

  $('robloxCentralOne').addEventListener('change', async () => {
    const activo = $('robloxCentralOne').checked;
    if (activo && !confirm('¿Activar la compra en Central One?\n\nCuando un paquete unido a Central One se quede sin códigos, la tienda lo seguirá vendiendo y comprará el código con tu saldo de Central One.')) {
      $('robloxCentralOne').checked = false;
      return;
    }
    const { error } = await cliente.rpc('admin_roblox_central_one', { p_activo: activo });
    if (error) { $('robloxCentralOne').checked = !activo; $('mensajeCentralOne').textContent = textoError(error, 'No se pudo cambiar.'); return; }
    $('mensajeCentralOne').textContent = activo ? '✅ Activado: los paquetes unidos a Central One se venden aunque no tengan códigos.' : 'Desactivado: sin códigos, el paquete sale Agotado.';
  });

  $('btnTraerRoblox').addEventListener('click', async () => {
    const b = $('btnTraerRoblox');
    b.disabled = true;
    $('estadoTraerRoblox').textContent = 'Preguntando a Central One…';
    try {
      const { data: s } = await cliente.auth.getSession();
      const res = await fetch('/api/juego?juego=roblox&accion=traer_productos', {
        method: 'POST', headers: { Authorization: 'Bearer ' + ((s && s.session && s.session.access_token) || '') },
      });
      const r = await res.json();
      $('estadoTraerRoblox').textContent = r.status === 'success'
        ? `✅ Central One tiene ${r.total} productos de Roblox (${r.conStock} con stock). Ya puedes unirlos a tus paquetes.`
        : (r.message || 'No se pudo traer el catálogo.');
      if (r.status === 'success') await cargarRoblox();
    } catch (e) {
      $('estadoTraerRoblox').textContent = 'No se pudo conectar. Intenta de nuevo.';
    } finally {
      b.disabled = false;
    }
  });

  $('formRoblox').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('mensajeRoblox');
    const codigos = $('robloxCodigos').value.split(/[\r\n,;]+/).map((c) => c.replace(/\s/g, '')).filter(Boolean);
    if (!codigos.length) { msg.textContent = 'Pega al menos un código.'; return; }
    if (codigos.length > 500) { msg.textContent = 'Máximo 500 códigos por vez.'; return; }
    const paquete = $('robloxPaquete').value;
    if (!paquete) { msg.textContent = 'Primero crea el paquete.'; return; }
    if (!confirm(`¿Guardar ${codigos.length} código${codigos.length === 1 ? '' : 's'} en ${$('robloxPaquete').selectedOptions[0].textContent}?\n\nRevisa que sea el paquete correcto: un código en el paquete equivocado le daría al cliente otra cantidad de Robux.`)) return;
    $('btnCargarRoblox').disabled = true;
    const { data, error } = await cliente.rpc('admin_roblox_cargar', { p_paquete: paquete, p_codigos: codigos });
    $('btnCargarRoblox').disabled = false;
    if (error || !data) { msg.textContent = textoError(error, 'No se pudieron guardar.'); return; }
    msg.textContent = `✅ ${data.nuevos} nuevo${data.nuevos === 1 ? '' : 's'} en ${$('robloxPaquete').selectedOptions[0].textContent}`
      + (data.repetidos ? ` · ${data.repetidos} ya estaban (no se repiten)` : '')
      + (data.invalidos ? ` · ${data.invalidos} con caracteres raros (no se guardaron)` : '') + '.';
    $('robloxCodigos').value = '';
    cargarRoblox();
  });

  // ---------------------------------------------------------------- descargar ventas en Excel
  // Tabla "recargas" (todas las tiendas) entre dos fechas de Venezuela. Reemplaza la pestaña "finalizados"
  // de las hojas. .xlsx con SheetJS (se descarga solo al tocar el botón); si no carga, .csv para Excel.
  const XLSX_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  const diaVE = (ms) => new Date(ms - 4 * 36e5).toISOString().slice(0, 10);
  $('excelHasta').value = diaVE(Date.now());
  $('excelDesde').value = diaVE(Date.now() - 6 * 864e5);
  // "2026-11-15 12:19" en hora de Venezuela (Excel lo reconoce como fecha)
  const fechaExcel = (iso) => new Date(new Date(iso).getTime() - 4 * 36e5).toISOString().slice(0, 16).replace('T', ' ');
  function cargarXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((ok, falla) => {
      const s = document.createElement('script');
      s.src = XLSX_CDN; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = () => (window.XLSX ? ok(window.XLSX) : falla(new Error('sin XLSX')));
      s.onerror = () => falla(new Error('no cargó SheetJS'));
      document.head.appendChild(s);
    });
  }
  function descargar(contenido, nombre, tipo) {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([contenido], { type: tipo }));
    a.download = nombre;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  // Respaldo: CSV con ";" y coma decimal, como lo abre Excel en español
  function csvParaExcel(datos) {
    const columnas = Object.keys(datos[0]);
    const celda = (v) => {
      const t = typeof v === 'number' ? v.toFixed(2).replace('.', ',') : String(v ?? '');
      // Que Excel no lo tome como fórmula
      const seguro = /^[=+\-@]/.test(t) ? `'${t}` : t;
      return /[;"\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
    };
    return '﻿' + [columnas.join(';'), ...datos.map((f) => columnas.map((c) => celda(f[c])).join(';'))].join('\r\n');
  }
  $('formExcel').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('mensajeExcel');
    const d = $('excelDesde').value;
    const h = $('excelHasta').value;
    if (!d || !h || d > h) { msg.textContent = 'Elige las fechas ("Desde" no puede ser después de "Hasta").'; return; }
    const desde = new Date(`${d}T00:00:00-04:00`);
    const hasta = new Date(new Date(`${h}T00:00:00-04:00`).getTime() + 864e5);
    const soloEstado = $('excelEstado').value;
    $('btnExcel').disabled = true;
    msg.textContent = 'Preparando…';
    try {
      const filas = await leerTodo(() => {
        let q = cliente.from('recargas')
          .select('creado,juego,paquete,cuenta,id_jugador,zona,precio,referencia,estado,codigo_descuento,id_pedido,nota_admin')
          .gte('creado', desde.toISOString()).lt('creado', hasta.toISOString()).order('creado', { ascending: true });
        if (soloEstado) q = q.eq('estado', soloEstado);
        return q;
      });
      if (!filas.length) { msg.textContent = 'No hay pedidos en esas fechas.'; return; }
      const datos = filas.map((r) => ({
        'Fecha (Venezuela)': fechaExcel(r.creado), 'Juego': JUEGOS[r.juego] || r.juego, 'Paquete': r.paquete || '',
        'Cuenta': r.cuenta || '', 'ID jugador': r.id_jugador || '', 'Zona': r.zona || '', 'Precio (Bs)': Number(r.precio || 0),
        'Referencia (últimos dígitos)': r.referencia || '', 'Estado': ESTADOS[r.estado] || r.estado,
        'Código de creador': r.codigo_descuento || '', 'Pedido': r.id_pedido, 'Nota': r.nota_admin || '',
      }));
      const nombre = `ventas-levelup-${d}-a-${h}`;
      try {
        const X = await cargarXlsx();
        const hoja = X.utils.json_to_sheet(datos);
        hoja['!cols'] = [18, 14, 26, 22, 14, 6, 12, 14, 14, 16, 38, 40].map((wch) => ({ wch }));
        const libro = X.utils.book_new();
        X.utils.book_append_sheet(libro, hoja, 'Ventas');
        X.writeFile(libro, `${nombre}.xlsx`);
      } catch (e) {
        console.error(e);
        descargar(csvParaExcel(datos), `${nombre}.csv`, 'text/csv;charset=utf-8');
      }
      const total = datos.reduce((s, f) => s + f['Precio (Bs)'], 0);
      msg.textContent = `✅ Descargado: ${datos.length} pedidos · ${bs(total)} Bs.`;
    } catch (error) {
      console.error(error);
      msg.textContent = 'No se pudo leer las ventas. Intenta de nuevo.';
    } finally {
      $('btnExcel').disabled = false;
    }
  });

  // ---------------------------------------------------------------- revisión (supabase/revision.sql)
  // Pedidos con problema de todas las tiendas y sus incidencias (lo que antes había que buscar en la
  // pestaña "errores" de cada hoja). Resolver cambia el estado del pedido (admin_revision_resolver).
  const NOMBRE_JUEGO = Object.assign({}, JUEGOS);
  let ultimaRevision = { abiertos: [], sueltas: [] };

  // "Marcar todas como entregadas": lo mismo que "✅ Ya la entregué" en cada pedido de la lista (fichas,
  // comisión del creador y el cliente la ve entregada) y cierra las incidencias sin pedido. Una tras otra,
  // nunca en paralelo, y solo las que se ven en la lista en ese momento.
  $('btnEntregarTodas').addEventListener('click', async () => {
    const { abiertos, sueltas } = ultimaRevision;
    if (!abiertos.length && !sueltas.length) return;
    const partes = [abiertos.length && `${abiertos.length} recarga(s) pasan a ENTREGADA`, sueltas.length && `${sueltas.length} aviso(s) sin pedido se cierran`].filter(Boolean);
    if (!confirm(`¿Marcar TODO lo de "Para revisar" como resuelto?\n\n• ${partes.join('\n• ')}\n\nLos clientes las verán entregadas en su perfil, y suman fichas y comisión del creador si aplica. Hazlo solo si ya las entregaste todas.`)) return;
    const b = $('btnEntregarTodas');
    const msg = $('mensajeRevision');
    b.disabled = true;
    let listas = 0;
    const fallos = [];
    for (const p of abiertos) {
      msg.textContent = `Marcando ${listas + fallos.length + 1} de ${abiertos.length + sueltas.length}…`;
      const { error } = await cliente.rpc('admin_revision_resolver', { p_id_pedido: p.id_pedido, p_accion: 'entregado', p_nota: null, p_incidencia: null });
      if (error) { console.error(error); fallos.push(`${p.paquete} (${p.cuenta || p.id_pedido})`); } else listas++;
    }
    for (const i of sueltas) {
      msg.textContent = `Marcando ${listas + fallos.length + 1} de ${abiertos.length + sueltas.length}…`;
      const { error } = await cliente.rpc('admin_revision_resolver', { p_id_pedido: '', p_accion: 'entregado', p_nota: null, p_incidencia: i.id });
      if (error) { console.error(error); fallos.push(`aviso ${i.paquete || i.id}`); } else listas++;
    }
    msg.textContent = fallos.length ? `✅ ${listas} listas. ❌ No se pudieron marcar: ${fallos.join(', ')}.` : `✅ Listo: ${listas} marcadas.`;
    b.disabled = false;
    cargarRevision();
    cargarPedidos();
  });

  async function cargarRevision() {
    const { data, error } = await cliente.rpc('admin_revision');
    const lista = $('listaRevision');
    if (error || !data) {
      console.error(error);
      lista.replaceChildren(el('li', 'vacio', 'No se pudo cargar. ¿Ya corriste supabase/revision.sql?'));
      return;
    }
    const abiertos = data.abiertos || [];
    const sueltas = data.sueltas || [];
    const total = abiertos.length + sueltas.length;
    ultimaRevision = { abiertos, sueltas };
    $('btnEntregarTodas').hidden = total === 0;
    $('contadorRevision').hidden = total === 0;
    $('contadorRevision').textContent = total;
    lista.replaceChildren();
    if (!total) lista.append(el('li', 'vacio', '✅ No hay nada que revisar.'));
    abiertos.forEach((p) => lista.append(tarjetaRevision(p)));
    sueltas.forEach((i) => lista.append(tarjetaSuelta(i)));

    const resueltas = $('listaResueltas');
    resueltas.replaceChildren();
    if (!(data.resueltos || []).length) resueltas.append(el('li', 'vacio', 'Todavía no has resuelto ninguna desde el panel.'));
    (data.resueltos || []).forEach((p) => {
      const li = el('li', 'pedido');
      const cabeza = el('div', 'pedido-cabeza');
      cabeza.append(el('strong', '', `${NOMBRE_JUEGO[p.juego] || p.juego} · ${p.paquete}`), el('span', 'etiqueta etiqueta--' + p.estado, ESTADOS[p.estado] || p.estado));
      li.append(cabeza, el('span', '', `${p.cuenta || ''}${p.precio ? ` · ${bs(p.precio)} Bs` : ''} · resuelta ${fecha(p.revisado)}`));
      if (p.nota_admin) li.append(el('span', 'precio-detalle', `📝 ${p.nota_admin}`));
      resueltas.append(li);
    });
  }

  function lineaIncidencia(i) {
    const caja = el('div', 'incidencia');
    caja.append(el('strong', '', `${i.fase || 'Problema'} · ${fecha(i.creado)}`));
    if (i.motivo) caja.append(el('span', '', i.motivo));
    if (i.estado_pago) caja.append(el('span', 'incidencia-pago', `Pago: ${i.estado_pago}`));
    if (i.comprobante) {
      const a = el('a', 'enlace-comprobante', 'Ver comprobante');
      a.href = i.comprobante; a.target = '_blank'; a.rel = 'noopener';
      caja.append(a);
    }
    return caja;
  }

  async function resolver(idPedido, accion, nota, incidencia, b) {
    if (b) b.disabled = true;
    const { error } = await cliente.rpc('admin_revision_resolver', { p_id_pedido: idPedido || '', p_accion: accion, p_nota: nota || null, p_incidencia: incidencia || null });
    if (error) { if (b) b.disabled = false; alert(textoError(error, 'No se pudo guardar.')); return; }
    cargarRevision();
    cargarPedidos();
  }

  function botonesResolver(p, li) {
    const acciones = el('div', 'acciones-cuenta');
    if (p.telefono) {
      acciones.append(enlaceWhatsapp(p.telefono,
        `Hola, te escribimos de Level Up por tu recarga de ${NOMBRE_JUEGO[p.juego] || p.juego} (${p.paquete}${p.referencia ? `, referencia …${p.referencia}` : ''}).`));
    }
    acciones.append(
      boton('✅ Ya la entregué', 'btn-ver btn-pagar', (b) => {
        if (confirm(`¿Marcar como ENTREGADA la recarga de ${p.paquete} (${p.cuenta || ''})?\n\nEl cliente la verá entregada en su perfil, y suma fichas y comisión del creador si aplica.`)) resolver(p.id_pedido, 'entregado', '', null, b);
      }),
      boton('↩️ Devolví el pago', 'btn-ver', (b) => {
        if (confirm(`¿Marcar como REEMBOLSADA la recarga de ${p.paquete} (${p.cuenta || ''})?\n\nEl cliente la verá reembolsada en su perfil.`)) resolver(p.id_pedido, 'reembolsado', '', null, b);
      }),
      boton('📝 Nota', 'btn-ver', () => {
        const nota = prompt('Nota para ti (solo la ves tú):', p.nota_admin || '');
        if (nota !== null) resolver(p.id_pedido, 'nota', nota, null, null);
      }));
    // Recargas de Central One: preguntarle qué pasó y volver a pedirla (api/_lib/revision.js)
    if (RECARGA_CENTRAL_ONE.has(p.juego)) {
      const salida = el('p', 'mensaje-form');
      salida.setAttribute('role', 'status');
      acciones.prepend(
        boton('🔎 Verificar estado', 'btn-ver', (b) => verificarRecarga(p, b, salida)),
        boton('🔁 Hacer de nuevo', 'btn-ver', (b) => rehacerRecarga(p, b, salida)));
      li.append(salida);
    }
    return acciones;
  }

  // ---------------------------------------------------------------- manuales (supabase/manuales.sql)
  // Pedidos de FC Mobile, COD Mobile y Clash Royale: la lista sale de "pedidos_manuales" (sin la contraseña);
  // la contraseña la descifra Vercel solo para el administrador (accion=clave). El estado lo cambia
  // admin_manual_estado (también la fila de "recargas" que ve el cliente; "completado" borra la contraseña).
  const ABIERTOS_MANUALES = ['pendiente', 'en_proceso', 'incompleto', 'problema'];
  async function cargarManuales() {
    const lista = $('listaManuales');
    const [{ data, error }, conClave, hechas] = await Promise.all([
      cliente.from('pedidos_manuales').select('id_pedido,juego,paquete,precio,pagado,referencia,metodo,usuario,telefono,estado,nota,comprobante,codigo_descuento,creado')
        .in('estado', ABIERTOS_MANUALES).order('creado', { ascending: true }).limit(200),
      cliente.rpc('admin_manuales_con_clave'),
      cliente.from('pedidos_manuales').select('id_pedido,juego,paquete,precio,usuario,estado,actualizado')
        .in('estado', ['completado', 'reembolsado']).order('actualizado', { ascending: false }).limit(15),
    ]);
    if (error || !data) {
      console.error(error);
      lista.replaceChildren(el('li', 'vacio', 'No se pudo cargar. ¿Ya corriste supabase/manuales.sql?'));
      return;
    }
    const guardadas = new Set(conClave.data || []);
    $('contadorManuales').hidden = !data.length;
    $('contadorManuales').textContent = data.length;
    lista.replaceChildren();
    if (!data.length) lista.append(el('li', 'vacio', '✅ No hay recargas manuales por hacer.'));
    data.forEach((p) => lista.append(tarjetaManual(p, guardadas.has(p.id_pedido))));

    const otras = $('listaManualesHechas');
    otras.replaceChildren();
    if (!(hechas.data || []).length) otras.append(el('li', 'vacio', 'Todavía no hay recargas manuales hechas.'));
    (hechas.data || []).forEach((p) => {
      const li = el('li', 'pedido');
      const cabeza = el('div', 'pedido-cabeza');
      cabeza.append(el('strong', '', `${JUEGOS[p.juego] || p.juego} · ${p.paquete}`), el('span', 'etiqueta etiqueta--' + p.estado, ESTADOS[p.estado] || p.estado));
      li.append(cabeza, el('span', '', `${p.usuario} · ${bs(p.precio)} Bs · ${fecha(p.actualizado)}`));
      otras.append(li);
    });
  }

  function tarjetaManual(p, tieneClave) {
    const li = el('li', 'pedido');
    const cabeza = el('div', 'pedido-cabeza');
    cabeza.append(el('strong', '', `${JUEGOS[p.juego] || p.juego} · ${p.paquete}`), el('span', 'etiqueta etiqueta--' + p.estado, ESTADOS[p.estado] || p.estado));
    li.append(cabeza,
      el('span', '', `${horaCorta(p.creado)} · ${bs(p.precio)} Bs (pagó ${bs(p.pagado)}) · ref …${String(p.referencia).slice(-5)}${p.codigo_descuento ? ` · código ${p.codigo_descuento}` : ''}`),
      el('span', '', `${p.metodo}: ${p.usuario}`));
    if (p.nota) li.append(el('span', 'precio-detalle', `📝 ${p.nota}`));
    if (p.comprobante && /^https:\/\//.test(p.comprobante)) {
      const a = el('a', 'enlace-comprobante', 'Ver comprobante');
      a.href = p.comprobante; a.target = '_blank'; a.rel = 'noopener';
      li.append(a);
    }
    const salida = el('p', 'mensaje-form');
    salida.setAttribute('role', 'status');
    const acciones = el('div', 'acciones-cuenta');
    if (p.telefono) {
      acciones.append(enlaceWhatsapp(p.telefono, `Hola, te escribimos de Level Up por tu recarga de ${JUEGOS[p.juego] || p.juego} (${p.paquete}).`));
    }
    if (tieneClave) acciones.append(boton('🔑 Ver contraseña', 'btn-ver', (b) => verClaveManual(p, b, salida)));
    if (p.estado !== 'en_proceso') acciones.append(boton('🔄 La estoy haciendo', 'btn-ver', (b) => estadoManual(p, 'en_proceso', b)));
    acciones.append(
      boton('✅ Hecha', 'btn-ver btn-pagar', (b) => {
        if (confirm(`¿Marcar como HECHA la recarga de ${p.paquete} (${p.usuario})?\n\nSe borra la contraseña y el cliente la ve entregada.`)) estadoManual(p, 'completado', b);
      }),
      boton('❌ Problema', 'btn-ver', (b) => {
        const nota = prompt('¿Qué pasó? (solo lo ves tú)', p.nota || '');
        if (nota !== null) estadoManual(p, 'problema', b, nota);
      }),
      boton('↩️ Devolví el pago', 'btn-ver', (b) => {
        if (confirm(`¿Marcar como REEMBOLSADA la recarga de ${p.paquete} (${p.usuario})?`)) estadoManual(p, 'reembolsado', b);
      }));
    li.append(acciones, salida);
    return li;
  }

  async function estadoManual(p, estadoNuevo, b, nota) {
    if (b) b.disabled = true;
    const { error } = await cliente.rpc('admin_manual_estado', { p_id_pedido: p.id_pedido, p_estado: estadoNuevo, p_nota: nota === undefined ? null : nota });
    if (error) { if (b) b.disabled = false; alert(textoError(error, 'No se pudo guardar.')); return; }
    cargarManuales();
    cargarPedidos();
  }

  async function verClaveManual(p, b, salida) {
    b.disabled = true;
    salida.textContent = 'Descifrando…';
    try {
      const { data: s } = await cliente.auth.getSession();
      const res = await fetch(`/api/juego?juego=${encodeURIComponent(p.juego)}&accion=clave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ((s && s.session && s.session.access_token) || '') },
        body: JSON.stringify({ idPedido: p.id_pedido }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok || r.status !== 'success') { salida.textContent = r.message || 'No se pudo leer la contraseña.'; b.disabled = false; return; }
      salida.replaceChildren(el('span', '', 'Usuario: '), el('strong', '', r.usuario), el('br'),
        el('span', '', 'Contraseña: '), el('strong', '', r.clave || '(sin contraseña)'));
      // Que no quede a la vista si se deja el panel abierto
      setTimeout(() => { salida.textContent = ''; b.disabled = false; }, 60000);
    } catch (e) {
      console.error(e);
      salida.textContent = 'No se pudo conectar. Intenta de nuevo.';
      b.disabled = false;
    }
  }
  $('actualizarManuales').addEventListener('click', cargarManuales);

  // ---------------------------------------------------------------- canjes (supabase/canjes.sql)
  // Códigos de regalo: crear (admin_canjes_crear), ver quién canjeó y borrar los libres (admin_canje_borrar)
  const ESTADO_CANJE = { libre: ['Libre', 'etiqueta--en_proceso'], entregando: ['En camino', 'etiqueta--pendiente'],
    entregado: ['Entregado', 'etiqueta--completado'], revisar: ['Por revisar', 'etiqueta--problema'] };
  async function cargarCanjes() {
    const lista = $('listaCanjes');
    const [{ data, error }, paquetes] = await Promise.all([
      cliente.from('codigos_regalo').select('codigo,paquete,nota,creado,canjeado,id_jugador,nombre,id_pedido,estado').order('creado', { ascending: false }).limit(300),
      cliente.rpc('admin_precios', { p_juego: 'freefire' }),
    ]);
    // Paquetes de Free Fire para el selector (los que tienen producto de Central One)
    const opciones = ((paquetes && paquetes.data && paquetes.data.paquetes) || []).filter((p) => p.producto && p.activo !== false).map((p) => p.paquete);
    if (opciones.length) {
      const sel = $('canjesPaquete');
      const actual = sel.value;
      sel.replaceChildren(...opciones.map((n) => { const o = el('option', '', n); o.value = n; return o; }));
      sel.value = opciones.includes(actual) ? actual : (opciones.includes('110 Diamantes') ? '110 Diamantes' : opciones[0]);
    }
    if (error) {
      console.error(error);
      lista.replaceChildren(el('li', 'vacio', 'No se pudo cargar. ¿Ya corriste supabase/canjes.sql?'));
      return;
    }
    $('kpiCanjesLibres').textContent = data.filter((c) => !c.canjeado).length;
    $('kpiCanjesUsados').textContent = data.filter((c) => c.canjeado).length;
    $('kpiCanjesEntregados').textContent = data.filter((c) => c.estado === 'entregado').length;
    $('kpiCanjesRevisar').textContent = data.filter((c) => c.estado === 'revisar').length;
    lista.replaceChildren();
    if (!data.length) { lista.append(el('li', 'vacio', 'Todavía no has creado códigos.')); return; }
    data.forEach((c) => {
      const [texto, clase] = ESTADO_CANJE[c.estado] || [c.estado, ''];
      const { li, cuerpo } = filaCompacta({ clave: 'canje:' + c.codigo, hora: horaCorta(c.canjeado || c.creado),
        titulo: c.canjeado ? `${c.codigo} · ${c.nombre || 'sin nombre'}` : c.codigo, monto: c.paquete, etiqueta: texto, claseEtiqueta: clase });
      cuerpo.append(el('span', '', `Creado ${fecha(c.creado)}${c.nota ? ` · ${c.nota}` : ''}`));
      if (c.canjeado) {
        cuerpo.append(el('span', '', `Canjeado ${fecha(c.canjeado)} por ${c.nombre || 'sin nombre'} (ID ${c.id_jugador})`));
        if (c.id_pedido) cuerpo.append(el('span', 'precio-detalle', `Pedido ${c.id_pedido}${c.estado === 'revisar' ? ' · está en Revisión: usa Verificar estado / Hacer de nuevo' : ''}`));
      }
      const acciones = el('div', 'acciones-cuenta');
      acciones.append(boton('📋 Copiar', 'btn-ver', async (b) => {
        try { await navigator.clipboard.writeText(c.codigo); b.textContent = '¡Copiado!'; } catch (e) { b.textContent = c.codigo; }
      }));
      if (!c.canjeado) {
        acciones.append(boton('🗑️ Borrar', 'btn-ver btn-ver--peligro', async (b) => {
          if (!confirm(`¿Borrar el código ${c.codigo}? Ya nadie podrá canjearlo.`)) return;
          b.disabled = true;
          const { data: ok, error: e } = await cliente.rpc('admin_canje_borrar', { p_codigo: c.codigo });
          if (e || !ok) { b.disabled = false; alert(e ? textoError(e, 'No se pudo borrar.') : 'Ya lo canjearon: no se puede borrar.'); }
          cargarCanjes();
        }));
      }
      cuerpo.append(acciones);
      lista.append(li);
    });
  }
  $('formCanjes').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('mensajeCanjes');
    const cantidad = Number($('canjesCantidad').value);
    const paquete = $('canjesPaquete').value;
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 50) { msg.textContent = 'Entre 1 y 50 códigos.'; return; }
    if (!confirm(`¿Crear ${cantidad} ${cantidad === 1 ? 'código' : 'códigos'} de ${paquete}?\n\nCada uno lo canjea el primero que llegue. Cada canje gasta saldo de Central One.`)) return;
    $('btnCanjes').disabled = true;
    const { data, error } = await cliente.rpc('admin_canjes_crear', { p_cantidad: cantidad, p_paquete: paquete, p_nota: $('canjesNota').value || null });
    $('btnCanjes').disabled = false;
    if (error) { msg.textContent = textoError(error, 'No se pudieron crear.'); return; }
    const codigos = (data || []).map((x) => (typeof x === 'string' ? x : Object.values(x)[0]));
    msg.textContent = `✅ ${codigos.length} códigos de ${paquete} creados.`;
    $('canjesTexto').value = codigos.join('\n');
    $('canjesNuevos').hidden = false;
    $('canjesNota').value = '';
    cargarCanjes();
  });
  $('btnCopiarCanjes').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('canjesTexto').value); $('btnCopiarCanjes').textContent = '¡Copiados!'; }
    catch (e) { $('canjesTexto').select(); }
    setTimeout(() => { $('btnCopiarCanjes').textContent = '📋 Copiar todos'; }, 2000);
  });
  $('actualizarCanjes').addEventListener('click', cargarCanjes);

  // ---------------------------------------------------------------- ruleta (supabase/ruleta.sql)
  // Ganadores de los últimos 30 días: los que faltan por entregar arriba, con "Ya lo entregué"
  async function cargarRuleta() {
    const lista = $('listaRuleta');
    const desde = new Date(Date.now() - 30 * 864e5).toISOString();
    const [{ data, error }, { count }] = await Promise.all([
      cliente.from('ruleta_giros').select('id_pedido,juego,id_jugador,referencia,premio,entregado,creado')
        .eq('gano', true).gte('creado', desde).order('entregado', { ascending: false, nullsFirst: true }).order('creado', { ascending: false }).limit(50),
      cliente.from('ruleta_giros').select('id_pedido', { count: 'exact', head: true }).gte('creado', iniciosVE().dia.toISOString()),
    ]);
    if (error) {
      console.error(error);
      lista.replaceChildren(el('li', 'vacio', 'No se pudo cargar. ¿Ya corriste supabase/ruleta.sql?'));
      return;
    }
    $('notaRuleta').textContent = `Giros de hoy: ${count ?? 0}. Cada recarga completada gira una vez (1 % de ganar).`;
    lista.replaceChildren();
    if (!data.length) { lista.append(el('li', 'vacio', 'Nadie ha ganado en los últimos 30 días.')); return; }
    data.forEach((g) => {
      const li = el('li', 'pedido' + (g.entregado ? '' : ' revision'));
      const cabeza = el('div', 'pedido-cabeza');
      cabeza.append(el('strong', '', `${JUEGOS[g.juego] || g.juego} · ${g.premio}`),
        el('span', 'etiqueta ' + (g.entregado ? 'etiqueta--completado' : 'etiqueta--incompleto'), g.entregado ? 'Entregado' : 'Por entregar'));
      li.append(cabeza, el('span', '', `ID ${g.id_jugador} · ref. …${g.referencia} · ganó ${fecha(g.creado)}${g.entregado ? ` · entregado ${fecha(g.entregado)}` : ''}`));
      if (!g.entregado) {
        const acciones = el('div', 'acciones-cuenta');
        acciones.append(boton('✅ Ya lo entregué', 'btn-ver btn-pagar', async (b) => {
          if (!confirm(`¿Ya entregaste ${g.premio} al ID ${g.id_jugador} (${JUEGOS[g.juego] || g.juego})?`)) return;
          b.disabled = true;
          const { error: e } = await cliente.from('ruleta_giros').update({ entregado: new Date().toISOString() }).eq('id_pedido', g.id_pedido);
          if (e) { b.disabled = false; alert('No se pudo guardar.'); return; }
          cargarRuleta();
        }));
        li.append(acciones);
      }
      lista.append(li);
    });
  }
  $('actualizarRuleta').addEventListener('click', cargarRuleta);

  // ---------------------------------------------------------------- revisión: Central One
  const RECARGA_CENTRAL_ONE = new Set(['freefire', 'bloodstrike', 'mobilelegends']);
  const ESTADO_CO = { completed: 'entregado', delivered: 'entregado', failed: 'falló', cancelled: 'cancelado', canceled: 'cancelado',
    refunded: 'reembolsado', confirmed: 'confirmado (en camino)', processing: 'procesando', pending: 'pendiente', partially_completed: 'entregado en parte', partially_delivered: 'entregado en parte' };
  const lineaPedidoCO = (o) => `${o.referencia} · ${ESTADO_CO[o.estado] || o.estado}${o.fallo ? ` (${MOTIVO_ADMIN[o.fallo] || o.fallo})` : ''}`;

  async function verificarRecarga(p, b, salida) {
    b.disabled = true;
    salida.textContent = 'Preguntando a Central One…';
    try {
      const r = await llamarAdmin('revision_verificar', { idPedido: p.id_pedido });
      if (r.status !== 'success') { salida.textContent = r.message || 'No se pudo verificar.'; return; }
      const detalle = r.pedidos.map(lineaPedidoCO).join(' · ');
      if (r.resultado === 'sin_pedido') {
        salida.textContent = '❌ Central One no tiene ningún pedido de esta recarga: nunca se pidió. Usa "Hacer de nuevo".';
      } else if (r.resultado === 'en_camino') {
        salida.textContent = `⏳ Central One la está entregando: ${detalle}. Verifica otra vez en unos minutos.`;
      } else if (r.resultado === 'en_parte') {
        salida.textContent = `⚠️ Central One entregó solo una parte (${r.partes} pedidos): ${detalle}. "Hacer de nuevo" pide solo la parte que falta.`;
      } else if (r.resultado === 'fallida') {
        salida.textContent = `❌ Central One no la entregó: ${detalle}. Si el ID está bien, usa "Hacer de nuevo".`;
      } else {
        salida.textContent = `✅ Central One la ENTREGÓ: ${detalle}.`;
        if (confirm(`Central One entregó la recarga de ${p.paquete} (${p.cuenta || ''}).\n\n${detalle}\n\n¿Marcarla como ENTREGADA?`)) {
          resolver(p.id_pedido, 'entregado', `Verificado en Central One: ${r.pedidos.map((o) => o.referencia).join(', ')}`, null, null);
        }
      }
    } catch (e) {
      salida.textContent = 'No se pudo conectar. Intenta de nuevo.';
    } finally {
      b.disabled = false;
    }
  }

  async function rehacerRecarga(p, b, salida) {
    if (!confirm(`¿Pedir OTRA VEZ a Central One la recarga de ${p.paquete} para ${p.cuenta || 'esta cuenta'}?\n\nAntes se revisa en Central One: si ya está entregada o en camino, no se pide de nuevo. Se gasta saldo de Central One.`)) return;
    b.disabled = true;
    salida.textContent = 'Pidiendo a Central One…';
    try {
      const r = await llamarAdmin('revision_rehacer', { idPedido: p.id_pedido });
      const hechos = (r.hechos || []).filter((h) => h.referencia).map((h) => `${h.referencia}${h.estado ? ` (${ESTADO_CO[h.estado] || h.estado})` : ''}`).join(' · ');
      salida.textContent = r.status === 'success' ? `✅ ${r.message}${hechos ? ` ${hechos}` : ''}` : `❌ ${r.message || 'No se pudo.'}`;
      if (r.status === 'success') setTimeout(cargarRevision, 4000);
    } catch (e) {
      salida.textContent = 'No se pudo conectar. No sabemos si se pidió: usa "Verificar estado" antes de volver a intentar.';
    } finally {
      b.disabled = false;
    }
  }

  function tarjetaRevision(p) {
    const li = el('li', 'pedido revision');
    const cabeza = el('div', 'pedido-cabeza');
    cabeza.append(el('strong', '', `${NOMBRE_JUEGO[p.juego] || p.juego} · ${p.paquete}`), el('span', 'etiqueta etiqueta--' + p.estado, ESTADOS[p.estado] || p.estado));
    li.append(cabeza,
      el('span', '', `${p.cuenta || ''}${p.precio ? ` · ${bs(p.precio)} Bs` : ''}${p.referencia ? ` · ref. …${p.referencia}` : ''}`),
      el('span', '', `${fecha(p.creado)} · ${p.id_pedido}`));
    if (p.motivo_fallo) li.append(el('span', 'motivo-fallo', `Central One: ${MOTIVO_ADMIN[p.motivo_fallo] || p.motivo_fallo}${ACCION_ADMIN[p.motivo_accion] ? ` → ${ACCION_ADMIN[p.motivo_accion]}` : ''}`));
    if (p.estado === 'en_proceso') li.append(el('span', 'motivo-fallo', 'Lleva más de 1 hora en proceso: revisa en Central One si se entregó.'));
    (p.incidencias || []).forEach((i) => li.append(lineaIncidencia(i)));
    if (p.nota_admin) li.append(el('span', 'precio-detalle', `📝 ${p.nota_admin}`));
    li.append(botonesResolver(p, li));
    return li;
  }

  // Problema anotado antes de que el pedido se guardara (p. ej. falló al verificar el pago)
  function tarjetaSuelta(i) {
    const li = el('li', 'pedido revision');
    const cabeza = el('div', 'pedido-cabeza');
    cabeza.append(el('strong', '', `${NOMBRE_JUEGO[i.juego] || i.juego || 'Tienda'} · ${i.paquete || 'sin paquete'}`), el('span', 'etiqueta etiqueta--problema', 'Sin pedido'));
    li.append(cabeza, el('span', '', `ID ${i.id_jugador || '?'}${i.referencia ? ` · ref. ${i.referencia}` : ''} · ${i.id_pedido || ''}`), lineaIncidencia(i));
    const acciones = el('div', 'acciones-cuenta');
    if (i.telefono) acciones.append(enlaceWhatsapp(i.telefono, `Hola, te escribimos de Level Up por tu recarga${i.paquete ? ` de ${i.paquete}` : ''}${i.referencia ? ` (referencia ${i.referencia})` : ''}.`));
    acciones.append(
      boton('✅ Resuelta', 'btn-ver btn-pagar', (b) => resolver('', 'entregado', '', i.id, b)),
      boton('↩️ Devolví el pago', 'btn-ver', (b) => resolver('', 'reembolsado', '', i.id, b)),
      boton('Descartar', 'btn-ver', (b) => { if (confirm('¿Descartar este aviso? No cambia nada más.')) resolver('', 'descartado', '', i.id, b); }));
    li.append(acciones);
    return li;
  }
  $('actualizarRevision').addEventListener('click', cargarRevision);

  // ---------------------------------------------------------------- Pago Móvil que ven los clientes
  // configuracion "pago_movil_cuentas" (privado): { cuentas: [{ nombre, banco, telefono, cedula, aviso, mostrar }], predeterminada }.
  // configuracion "pago_movil" (publico, lo único que leen las tiendas con js/datos-pago.js):
  //   { banco, telefono, cedula (la predeterminada), cuentas: [las que se muestran], predeterminada }.
  // En la tienda el cliente elige a qué banco paga (la predeterminada viene marcada) y ve el aviso de cada
  // cuenta. Las dos se publican en UNA petición. Solo administradores escriben (RLS).
  const CUENTAS_PM = 2;
  // Nota opcional que el cliente ve junto a los bancos (js/datos-pago.js). Reemplazó el 2026-11-15 a la
  // "condición + casilla" (aviso de UBI/Mercantil que ocultaba los datos hasta aceptarlo).
  let cuentasPm = [];
  let predeterminadaPm = 0;
  let notaPm = '';
  async function cargarCuentasPm() {
    const { data, error } = await cliente.from('configuracion').select('clave,valor').in('clave', ['pago_movil', 'pago_movil_cuentas']);
    if (error) { console.error(error); $('cuentasPm').replaceChildren(el('p', 'nota', 'No se pudieron cargar los datos de Pago Móvil.')); return; }
    const de = (clave) => ((data || []).find((f) => f.clave === clave) || {}).valor;
    const publico = de('pago_movil') || {};
    const guardadas = de('pago_movil_cuentas');
    cuentasPm = guardadas && Array.isArray(guardadas.cuentas) ? guardadas.cuentas.slice(0, CUENTAS_PM) : [
      { nombre: 'BDV', banco: publico.banco || '', telefono: publico.telefono || '', cedula: publico.cedula || '' },
    ];
    while (cuentasPm.length < CUENTAS_PM) cuentasPm.push({ nombre: '', banco: '', telefono: '', cedula: '' });
    // Cuentas guardadas antes de que existiera "mostrar" (2026-11-15): visibles
    cuentasPm = cuentasPm.map((c) => ({ ...c, mostrar: c.mostrar !== false && !!c.banco, aviso: c.aviso || '' }));
    notaPm = String((guardadas && guardadas.nota) ?? publico.nota ?? '');
    const igual = (c) => c.banco && c.banco === publico.banco && c.telefono === publico.telefono && c.cedula === publico.cedula;
    predeterminadaPm = Number.isInteger(guardadas && guardadas.predeterminada) ? guardadas.predeterminada : Math.max(0, cuentasPm.findIndex(igual));
    pintarCuentasPm(publico);
  }

  function pintarCuentasPm(publico) {
    const caja = $('cuentasPm');
    caja.replaceChildren();
    const enTienda = Array.isArray(publico.cuentas) ? publico.cuentas.map((c) => c.banco).join(' y ') : publico.banco;
    if (enTienda) caja.append(el('p', 'nota', `Ahora la tienda muestra: ${enTienda}.`));
    const form = el('form', 'formulario');
    form.noValidate = true;
    const lista = el('div', 'cuentas-pm');
    const campo = (texto, nombre, valor, extra) => {
      const label = el('label', 'campo', texto);
      const input = el('input');
      Object.assign(input, { name: nombre, value: valor || '', maxLength: 40, autocomplete: 'off' }, extra);
      label.append(input);
      return label;
    };
    const opcion = (texto, tipo, nombre, marcado) => {
      const label = el('label', 'opcion-pm');
      const input = el('input');
      Object.assign(input, { type: tipo, name: nombre, checked: marcado });
      label.append(input, texto);
      return label;
    };
    cuentasPm.forEach((c, i) => {
      const p = `pm${i}_`;
      const fila = el('fieldset', 'cuenta-pm' + (i === predeterminadaPm && c.mostrar ? ' cuenta-pm--activa' : ''));
      fila.append(el('legend', '', c.nombre || `Cuenta ${i + 1}`));
      const fila1 = el('div', 'dos-campos');
      fila1.append(campo('Nombre (solo lo ves tú)', p + 'nombre', c.nombre, { placeholder: 'Ej. BDV' }),
        campo('Banco (como lo ve el cliente)', p + 'banco', c.banco, { placeholder: 'Ej. Venezuela 0102' }));
      const fila2 = el('div', 'dos-campos');
      fila2.append(campo('Teléfono', p + 'telefono', c.telefono, { inputMode: 'numeric', placeholder: 'Ej. 04141234567' }),
        campo('Cédula', p + 'cedula', c.cedula, { placeholder: 'Ej. 12345678' }));
      const aviso = campo('Aviso de esta cuenta (opcional)', p + 'aviso', c.aviso, { maxLength: 160, placeholder: 'Sale debajo de los botones de banco' });
      const opciones = el('div', 'acciones-cuenta');
      opciones.append(opcion('Mostrar en la tienda', 'checkbox', p + 'mostrar', c.mostrar),
        opcion('Predeterminada (ya viene marcada)', 'radio', 'pm_predeterminada', i === predeterminadaPm));
      fila.append(fila1, fila2, aviso, opciones);
      lista.append(fila);
    });
    // Nota para el cliente: sale junto a los bancos disponibles (vacía = no se muestra nada)
    const nota = el('fieldset', 'cuenta-pm');
    nota.append(el('legend', '', 'Nota para el cliente'),
      campo('Nota (opcional)', 'pm_nota', notaPm, { maxLength: 300, placeholder: 'Ej. Los pagos se verifican en unos minutos.' }),
      el('p', 'nota', 'Se muestra arriba de los datos de pago, en las tiendas y en el perfil. Déjala vacía para no mostrar nada.'));
    const guardar = el('button', 'btn btn--chico', 'Guardar y publicar');
    guardar.type = 'submit';
    form.append(nota, lista, guardar);
    form.addEventListener('submit', (ev) => { ev.preventDefault(); guardarCuentasPm(form, guardar); });
    caja.append(form);
  }

  // Lee y revisa las cuentas del formulario: { cuentas, predeterminada } o { problema }
  function cuentasDelForm(form) {
    const cuentas = [];
    const radios = form.querySelectorAll('input[name="pm_predeterminada"]');
    let predeterminada = -1;
    for (let i = 0; i < cuentasPm.length; i++) {
      const v = (n) => form.elements[`pm${i}_${n}`];
      const c = { nombre: v('nombre').value.trim().slice(0, 30), banco: v('banco').value.trim().replace(/\s+/g, ' '),
        telefono: v('telefono').value.replace(/\D/g, ''), cedula: v('cedula').value.replace(/[^\dVEve]/g, '').toUpperCase(),
        aviso: v('aviso').value.trim().replace(/\s+/g, ' ').slice(0, 160), mostrar: v('mostrar').checked };
      if (c.telefono.startsWith('58')) c.telefono = c.telefono.slice(2);
      if (c.telefono && !c.telefono.startsWith('0')) c.telefono = '0' + c.telefono;
      const quien = c.nombre || `Cuenta ${i + 1}`;
      const vacia = !c.banco && !c.telefono && !c.cedula;
      if (c.mostrar || !vacia) {
        if (c.banco.length < 3) return { problema: `${quien}: escribe el banco, por ejemplo "Venezuela 0102".` };
        if (!/^04(12|14|16|22|24|26)\d{7}$/.test(c.telefono)) return { problema: `${quien}: el teléfono debe ser un celular, por ejemplo 04141234567.` };
        if (!/^[VE]?\d{6,9}$/.test(c.cedula)) return { problema: `${quien}: la cédula, solo números (por ejemplo 12345678).` };
      }
      if (radios[i] && radios[i].checked) predeterminada = i;
      cuentas.push(c);
    }
    const nota = String(form.elements.pm_nota.value || '').trim().replace(/\s+/g, ' ').slice(0, 300);
    if (!cuentas.some((c) => c.mostrar)) return { problema: 'Deja al menos una cuenta con "Mostrar en la tienda".' };
    if (predeterminada < 0 || !cuentas[predeterminada].mostrar) return { problema: 'La predeterminada también tiene que estar en "Mostrar en la tienda".' };
    return { cuentas, predeterminada, nota };
  }

  async function guardarCuentasPm(form, b) {
    const msg = $('mensajePm');
    const { cuentas, predeterminada, nota, problema } = cuentasDelForm(form);
    if (problema) { msg.textContent = problema; return; }
    // En la tienda la predeterminada va primero
    const p = cuentas[predeterminada];
    const visibles = [p, ...cuentas.filter((c) => c.mostrar && c !== p)];
    const publicas = visibles.map(({ banco, telefono, cedula, aviso }) => ({ banco, telefono, cedula, ...(aviso && { aviso }) }));
    const resumen = visibles.map((c) => `• ${c.banco} · ${c.telefono} · C.I. ${c.cedula}${c === p ? '  ← predeterminada' : ''}`).join('\n');
    if (!confirm(`¿Publicar en la tienda?\n\n${resumen}${visibles.length > 1 ? '\n\nEl cliente elige a cuál paga; la predeterminada ya viene marcada.' : ''}`)) return;
    const ahora = new Date().toISOString();
    const filas = [
      { clave: 'pago_movil_cuentas', valor: { cuentas, predeterminada, nota }, publico: false, actualizado: ahora },
      { clave: 'pago_movil', valor: { banco: p.banco, telefono: p.telefono, cedula: p.cedula, cuentas: publicas, predeterminada: visibles.indexOf(p), ...(nota && { nota }) }, publico: true, actualizado: ahora },
    ];
    b.disabled = true;
    try {
      const { error } = await cliente.from('configuracion').upsert(filas, { onConflict: 'clave' });
      if (error) throw error;
      msg.textContent = '✅ Publicado: los clientes lo ven al abrir o recargar la tienda.';
      await cargarCuentasPm();
    } catch (e) {
      console.error(e);
      msg.textContent = 'No se pudo guardar. Intenta de nuevo.';
    } finally {
      b.disabled = false;
    }
  }

  // ---------------------------------------------------------------- pagos (supabase/pagos.sql)
  const ORIGEN_PAGO = { pago_movil: 'Pago móvil', bdv: 'BDV a BDV', transferencia: 'Transferencia', manual: 'Agregado a mano', otro: 'Otro' };
  const ESTADO_PAGO = { verificado: ['Libre', 'etiqueta--completado'], en_proceso: ['En proceso', 'etiqueta--en_proceso'],
    usado: ['Usado', 'etiqueta--reembolsado'], por_completar: ['Por completar', 'etiqueta--incompleto'], vencido: ['Vencido', 'etiqueta--problema'] };
  let pagos = [];
  let pedidosDePagos = {};   // id_pedido -> { juego, paquete, cuenta, estado }
  const COLUMNAS_PAGO = 'referencia,monto,monto_texto,remitente,origen,recibido,estado,id_pedido,juego,tomado,usado,nota';
  // ---------------------------------------------------------------- pagos verificados a mano
  // Interruptor (configuracion "pagos_manual", privado) y la lista de pagos_solicitudes pendientes
  // (supabase/pagos-manual.sql). Aprobar y rechazar pasan por Vercel (api/_lib/pagos-manual.js).
  async function cargarPagosManual() {
    const { data } = await cliente.from('configuracion').select('valor').eq('clave', 'pagos_manual').maybeSingle();
    const activo = !!(data && data.valor === true);
    $('pagosManualActivo').checked = activo;
    $('mensajePagosManual').textContent = activo
      ? '🖐️ Encendido: las referencias que no lleguen esperan tu aprobación en Pagos.'
      : 'Apagado: una referencia que no llegó se rechaza como siempre ("Referencia no encontrada").';
  }
  $('pagosManualActivo').addEventListener('change', async (ev) => {
    const activar = ev.target.checked;
    const texto = activar
      ? '¿Verificar a mano los pagos que no lleguen?\n\nSi un cliente escribe una referencia que no llegó, verá "Estamos verificando tu pago" y su pedido como "Recibido". Tú lo apruebas (la recarga se hace sola) o lo rechazas en Pagos → Pagos por aprobar.'
      : '¿Apagar la verificación a mano?\n\nLas referencias que no lleguen se rechazan otra vez como "no encontrada". Las que ya están por aprobar siguen en la lista.';
    if (!confirm(texto)) { cargarPagosManual(); return; }
    ev.target.disabled = true;
    const { error } = await cliente.from('configuracion').upsert({ clave: 'pagos_manual', valor: activar, publico: false, actualizado: new Date().toISOString() }, { onConflict: 'clave' });
    ev.target.disabled = false;
    if (error) { console.error(error); alert('No se pudo guardar. Intenta de nuevo.'); }
    cargarPagosManual();
  });

  const TITULO_PANEL = document.title;
  async function cargarPorAprobar() {
    const lista = $('listaPorAprobar');
    const { data, error } = await cliente.from('pagos_solicitudes').select('id,ultimos5,juego,monto,id_jugador,paquete,telefono,creado')
      .eq('estado', 'pendiente').order('creado', { ascending: true }).limit(100);
    if (error) {
      // Sin la tabla (falta correr supabase/pagos-manual.sql) no se molesta en ninguna otra parte
      lista.replaceChildren(el('li', 'vacio', 'Todavía no está instalado: corre supabase/pagos-manual.sql en Supabase.'));
      $('contadorPagos').hidden = true;
      return;
    }
    const n = (data || []).length;
    $('contadorPagos').hidden = n === 0;
    $('contadorPagos').textContent = n;
    document.title = n ? `(${n}) ${TITULO_PANEL}` : TITULO_PANEL;
    // Si el administrador está escribiendo en una fila, no se repinta la lista (perdería lo escrito)
    if (lista.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    lista.replaceChildren();
    if (!n) { lista.append(el('li', 'vacio', '✅ No hay pagos por aprobar.')); return; }
    data.forEach((s) => lista.append(filaPorAprobar(s)));
  }

  function filaPorAprobar(s) {
    const li = el('li', 'pedido');
    const cabeza = el('div', 'pedido-cabeza');
    cabeza.append(el('strong', '', `${JUEGOS[s.juego] || s.juego}${s.paquete ? ' · ' + s.paquete : ''}`), el('span', 'etiqueta etiqueta--en_revision', hace(s.creado)));
    const datos = el('span', '');
    datos.append('Termina en ', el('strong', 'codigo-nombre', s.ultimos5), s.id_jugador ? ` · ID ${s.id_jugador}` : '');
    li.append(cabeza, datos);
    if (Number(s.monto) > 0) li.append(el('span', 'por-aprobar-monto', `Debe llegar: ${bs(s.monto)} Bs`));
    const campos = el('div', 'aprobar-campos');
    const ref = el('input');
    ref.type = 'text'; ref.inputMode = 'numeric'; ref.maxLength = 30; ref.autocomplete = 'off';
    ref.placeholder = `Referencia completa (termina en ${s.ultimos5})`;
    ref.setAttribute('aria-label', `Referencia completa del pago que termina en ${s.ultimos5}`);
    const monto = el('input');
    monto.type = 'text'; monto.inputMode = 'decimal'; monto.maxLength = 20; monto.autocomplete = 'off';
    monto.placeholder = 'Monto que llegó (Bs)';
    monto.setAttribute('aria-label', 'Monto que llegó en Bs');
    if (Number(s.monto) > 0) monto.value = bs(s.monto);
    campos.append(ref, monto);
    const salida = el('p', 'mensaje-form');
    salida.setAttribute('role', 'status');
    const acciones = el('div', 'acciones-cuenta');
    if (s.telefono) acciones.append(enlaceWhatsapp(s.telefono, `Hola, te escribimos de Level Up por tu pago con referencia terminada en ${s.ultimos5}.`));
    acciones.append(
      boton('✅ Aprobar', 'btn-ver btn-pagar', (b) => resolverSolicitud(s, 'aprobar', b, salida, ref.value, monto.value)),
      boton('❌ Rechazar', 'btn-ver btn-ver--peligro', (b) => resolverSolicitud(s, 'rechazar', b, salida)));
    li.append(campos, acciones, salida);
    return li;
  }

  async function resolverSolicitud(s, accion, b, salida, referencia, monto) {
    if (accion === 'aprobar') {
      const ref = String(referencia || '').replace(/\D/g, '');
      if (ref.length < 6) { salida.textContent = 'Escribe la referencia completa que sale en el banco.'; return; }
      if (!ref.endsWith(s.ultimos5)) { salida.textContent = `La referencia debe terminar en ${s.ultimos5} (lo que escribió el cliente).`; return; }
      if (!String(monto || '').trim()) { salida.textContent = 'Escribe el monto que llegó.'; return; }
      if (!confirm(`¿APROBAR el pago ${ref} por ${monto} Bs?\n\nSe hace YA la recarga del cliente (${JUEGOS[s.juego] || s.juego}${s.paquete ? ', ' + s.paquete : ''}${s.id_jugador ? ', ID ' + s.id_jugador : ''}). La ve en "Consulta tus últimas recargas" y en su perfil.`)) return;
    } else if (!confirm(`¿RECHAZAR el pago que termina en ${s.ultimos5}?\n\nSu pedido quedará "Con problema" y le diremos que escriba por WhatsApp.`)) return;
    b.disabled = true;
    if (accion === 'aprobar') salida.textContent = '⏳ Aprobando y haciendo la recarga… (puede tardar hasta un minuto)';
    try {
      // Va por /api/recargar: al aprobar se hace la recarga, que necesita su tiempo (api/_lib/pagos-manual.js)
      const r = await llamarAdmin('solicitud_resolver', accion === 'aprobar' ? { id: s.id, accion, referencia, monto } : { id: s.id, accion }, '/api/recargar');
      if (r.status !== 'success') { salida.textContent = '❌ ' + (r.message || 'No se pudo guardar.'); b.disabled = false; return; }
      if (accion === 'aprobar') alert(`Pago aprobado.\n\n${r.recarga || ''}${r.aviso ? '\n\n' + r.aviso : ''}`);
      if (document.activeElement) document.activeElement.blur();
      cargarPorAprobar();
      cargarPedidos();
      if (accion === 'aprobar') cargarPagos();
    } catch (e) {
      salida.textContent = 'No se pudo conectar. Intenta de nuevo.';
      b.disabled = false;
    }
  }
  $('actualizarPorAprobar').addEventListener('click', () => cargarPorAprobar().catch(() => {}));
  // Cada 10 s con la página visible (también con otra pestaña del panel abierta: el contador avisa)
  setInterval(() => { if (cliente && !$('panel').hidden && document.visibilityState === 'visible') cargarPorAprobar().catch(() => {}); }, 10000);

  async function cargarPagos() {
    const desde = desdePeriodo($('periodoPagos').value);
    let data;
    try {
      data = await leerTodo(() => {
        let q = cliente.from('pagos').select(COLUMNAS_PAGO).order('recibido', { ascending: false });
        if (desde) q = q.gte('recibido', desde.toISOString());
        return q;
      });
    } catch (error) {
      console.error(error);
      $('listaPagos').replaceChildren(el('li', 'vacio', 'No se pudieron cargar los pagos.'));
      return;
    }
    pagos = data;
    await cargarPedidosDePagos(pagos);
    $('kpiPagos').textContent = pagos.length;
    $('kpiPagosBs').textContent = bs(pagos.reduce((s, p) => s + Number(p.monto || 0), 0));
    $('kpiPagosPm').textContent = pagos.filter((p) => p.origen === 'pago_movil').length;
    $('kpiPagosTr').textContent = pagos.filter((p) => p.origen !== 'pago_movil').length;
    pintarPagos();
  }
  // Juego, paquete y cuenta del pedido que usó cada pago
  async function cargarPedidosDePagos(lista) {
    const ids = [...new Set(lista.map((p) => p.id_pedido).filter((id) => id && !pedidosDePagos[id]))];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await cliente.from('recargas').select('id_pedido,juego,paquete,cuenta,estado').in('id_pedido', ids.slice(i, i + 200));
      (data || []).forEach((r) => { pedidosDePagos[r.id_pedido] = r; });
    }
  }
  // Buscar en TODOS los pagos guardados (no solo el periodo): por referencia o sus últimos 5
  let buscando = 0;
  async function buscarPagosServidor(texto) {
    const digitos = texto.replace(/\D/g, '');
    if (digitos.length < 4) return;
    const turno = ++buscando;
    const [{ data }, borrados] = await Promise.all([
      cliente.from('pagos').select(COLUMNAS_PAGO).like('referencia', `%${digitos}%`).order('recibido', { ascending: false }).limit(50),
      usadosBorrados(digitos),
    ]);
    if (turno !== buscando || !data) return;
    const vistos = new Set(pagos.map((p) => p.referencia));
    data.forEach((p) => { if (!vistos.has(p.referencia)) { pagos.push(p); vistos.add(p.referencia); } });
    borrados.forEach((p) => { if (!vistos.has(p.referencia)) pagos.push(p); });
    await cargarPedidosDePagos(data);
    pintarPagos();
  }

  // Pagos usados que la limpieza diaria ya borró (sus referencias quedan 60 días: admin_pagos_usados_buscar)
  async function usadosBorrados(digitos) {
    const { data, error } = await cliente.rpc('admin_pagos_usados_buscar', { p_digitos: digitos });
    if (error) { console.error(error); return []; }
    return (data || []).map((u) => ({ referencia: u.referencia, usado: u.usado, estado: 'borrado', borrado: true }));
  }

  function pintarPagos() {
    const texto = $('buscarPago').value.replace(/\s/g, '').toLowerCase();
    const lista = $('listaPagos');
    lista.replaceChildren();
    const visibles = pagos.filter((p) => !texto || `${p.referencia} ${p.monto} ${p.monto_texto || ''} ${p.remitente || ''}`.toLowerCase().includes(texto));
    if (!visibles.length) { lista.append(el('li', 'vacio', pagos.length ? 'Ningún pago con esa búsqueda.' : 'Todavía no llega ningún pago a Supabase en este periodo.')); return; }
    // Buscando con pocos resultados: se abren solos
    const abrir = !!texto && visibles.length <= 3;
    const trozo = document.createDocumentFragment();
    visibles.forEach((p) => {
      if (p.borrado) {
        const { li, cuerpo } = filaCompacta({ clave: 'pago:' + p.referencia, hora: horaCorta(p.usado), titulo: `ref. …${p.referencia.slice(-5)}`,
          etiqueta: 'Usado (borrado)', claseEtiqueta: 'etiqueta--problema', abrir });
        cuerpo.append(el('span', '', `Referencia ${p.referencia}`),
          el('span', '', `Se usó el ${fecha(p.usado)}. La limpieza diaria lo borró: nadie puede volver a usarlo ni agregarlo a mano.`));
        trozo.append(li);
        return;
      }
      const [estado, clase] = ESTADO_PAGO[p.estado] || [p.estado, ''];
      const { li, cuerpo } = filaCompacta({ clave: 'pago:' + p.referencia, hora: horaCorta(p.recibido),
        titulo: `ref. …${p.referencia.slice(-5)}${p.remitente ? ` · ${p.remitente}` : ''}`, monto: `${bs(p.monto)} Bs`,
        etiqueta: estado, claseEtiqueta: clase, abrir });
      cuerpo.append(el('span', '', `Referencia ${p.referencia} · ${bs(p.monto)} Bs`),
        el('span', '', `Llegó ${fecha(p.recibido)} · ${ORIGEN_PAGO[p.origen] || p.origen}${p.remitente ? ` · ${p.remitente}` : ''}`));
      if (p.tomado) cuerpo.append(el('span', '', `Apartado ${fecha(p.tomado)}${p.usado ? ` · usado ${fecha(p.usado)}` : ''}${p.juego ? ` · ${JUEGOS[p.juego] || p.juego}` : ''}`));
      else if (p.usado) cuerpo.append(el('span', '', `Usado ${fecha(p.usado)}`));
      if (p.id_pedido) {
        const ped = pedidosDePagos[p.id_pedido];
        cuerpo.append(el('span', 'precio-detalle', ped
          ? `Pedido: ${JUEGOS[ped.juego] || ped.juego} · ${ped.paquete} · ${ped.cuenta} · ${ESTADOS[ped.estado] || ped.estado}`
          : `Pedido ${p.id_pedido}`));
      }
      if (p.nota) cuerpo.append(el('span', 'precio-detalle', `📝 ${p.nota}`));
      const acciones = el('div', 'acciones-cuenta');
      if (p.estado !== 'usado') {
        acciones.append(boton('✔️ Marcar usado', 'btn-ver', (b) => cambiarEstadoPago(p, 'usado', b)));
      }
      if (p.estado === 'en_proceso' || p.estado === 'por_completar') {
        acciones.append(boton('↩️ Liberar', 'btn-ver', (b) => cambiarEstadoPago(p, 'verificado', b)));
      }
      if (acciones.childNodes.length) cuerpo.append(acciones);
      trozo.append(li);
    });
    lista.append(trozo);
  }
  async function cambiarEstadoPago(p, estado, b) {
    const texto = estado === 'usado'
      ? `¿Marcar como USADO el pago ${p.referencia} (${bs(p.monto)} Bs)?\n\nYa nadie podrá usarlo en la tienda. Úsalo para un pago que ya gastaste a mano, por ejemplo una recarga por WhatsApp.`
      : `¿LIBERAR el pago ${p.referencia} (${bs(p.monto)} Bs)?\n\nVuelve a estar libre y el cliente lo puede usar otra vez con sus últimos 5 dígitos.`;
    if (!confirm(texto)) return;
    b.disabled = true;
    try {
      const r = await llamarAdmin('pago_estado', { referencia: p.referencia, estado });
      if (r.status !== 'success') { alert(r.message || 'No se pudo cambiar.'); b.disabled = false; return; }
      cargarPagos();
    } catch (e) {
      alert('No se pudo conectar. Intenta de nuevo.');
      b.disabled = false;
    }
  }

  $('periodoPagos').addEventListener('change', cargarPagos);
  // Con la pestaña Pagos abierta (y la página visible) la lista se renueva sola cada 15 s; si hay una
  // búsqueda escrita, se repite para no perder los resultados del servidor (p. ej. los usados ya borrados)
  setInterval(async () => {
    if (!cliente || document.visibilityState !== 'visible' || $('seccion-pagos').hidden) return;
    try {
      await cargarPagos();
      const texto = $('buscarPago').value;
      if (texto.replace(/\D/g, '').length >= 4) await buscarPagosServidor(texto);
    } catch (e) { /* el próximo intento */ }
  }, 15000);
  let esperaBusqueda = 0;
  $('buscarPago').addEventListener('input', () => {
    pintarPagos();
    clearTimeout(esperaBusqueda);
    esperaBusqueda = setTimeout(() => buscarPagosServidor($('buscarPago').value), 400);
  });

  async function llamarAdmin(accion, cuerpo, ruta = '/api/juego') {
    const { data: s } = await cliente.auth.getSession();
    const res = await fetch(`${ruta}?accion=${accion}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ((s && s.session && s.session.access_token) || '') },
      body: JSON.stringify(cuerpo || {}),
    });
    return res.json();
  }

  $('formPagoManual').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('mensajePagoManual');
    const referencia = $('manualReferencia').value.replace(/\D/g, '');
    const monto = $('manualMonto').value.trim();
    if (referencia.length < 6) { msg.textContent = 'Escribe la referencia completa (solo números).'; return; }
    if (!monto) { msg.textContent = 'Escribe el monto en Bs.'; return; }
    const ultimos5 = referencia.slice(-5);
    $('btnPagoManual').disabled = true;
    let iguales = [];
    try {
      const [{ data }, borrados] = await Promise.all([
        cliente.from('pagos').select('referencia,monto,estado,recibido').like('referencia', `%${ultimos5}`).limit(20),
        usadosBorrados(ultimos5),
      ]);
      iguales = [...(data || []), ...borrados].filter((p) => p.referencia.endsWith(ultimos5));
    } catch (e) { /* sin la comprobación se pregunta igual */ }
    $('btnPagoManual').disabled = false;
    const mismo = iguales.find((p) => p.referencia === referencia);
    if (mismo) {
      msg.textContent = mismo.borrado
        ? `❌ Ese pago ya se usó el ${fecha(mismo.usado)}: no se puede agregar otra vez.`
        : `❌ Ese pago ya está en la lista (${(ESTADO_PAGO[mismo.estado] || [mismo.estado])[0]}): no hace falta agregarlo.`;
      return;
    }
    const aviso = iguales.length
      ? `\n\n⚠️ OJO: ya hay ${iguales.length === 1 ? 'otro pago que termina' : `${iguales.length} pagos que terminan`} en ${ultimos5}:\n`
        + iguales.map((p) => p.borrado
          ? `• ${p.referencia} · usado el ${fecha(p.usado)} (ya borrado)`
          : `• ${p.referencia} · ${bs(p.monto)} Bs · ${(ESTADO_PAGO[p.estado] || [p.estado])[0]} · llegó ${fecha(p.recibido)}`).join('\n')
        + `\n\nRevisa que no sea el mismo pago con otra referencia. Si los dos quedan libres, el cliente que escriba ${ultimos5} se lleva el más reciente.`
      : '';
    if (!confirm(`¿Agregar el pago ${referencia} por ${monto} Bs?\n\nQuedará libre para que el cliente lo use con sus últimos 5 dígitos (${ultimos5}).${aviso}`)) return;
    $('btnPagoManual').disabled = true;
    try {
      const r = await llamarAdmin('pago_manual', { referencia, monto, remitente: $('manualRemitente').value, nota: $('manualNota').value });
      msg.textContent = r.status === 'success'
        ? `✅ Pago agregado. El cliente ya puede usar …${referencia.slice(-5)}.`
        : (r.message || 'No se pudo agregar.');
      if (r.status === 'success') { $('formPagoManual').reset(); cargarPagos(); }
    } catch (e) {
      msg.textContent = 'No se pudo conectar. Intenta de nuevo.';
    } finally {
      $('btnPagoManual').disabled = false;
    }
  });

  $('btnLimpiarPagos').addEventListener('click', async () => {
    if (!confirm('¿Limpiar ahora?\n\nSe borran los pagos USADOS de días anteriores y los vencidos de más de 7 días. Los libres no se tocan.')) return;
    const r = await llamarAdmin('pagos_limpiar');
    alert(r.status === 'success' ? `Listo: ${r.usados_borrados} usados borrados, ${r.vencidos} pasaron a vencido, ${r.vencidos_borrados} vencidos borrados.` : (r.message || 'No se pudo limpiar.'));
    cargarPagos();
  });

  // "Entrar con Google": si había otra cuenta (no administradora), primero se cierra
  $('btnEntrarAdmin').addEventListener('click', async (ev) => {
    ev.preventDefault();
    try { if (window.Sesion && Sesion.hay()) await Sesion.salir(); } catch (e) { /* igual se va a entrar */ }
    location.href = $('btnEntrarAdmin').href;
  });

  // ---------------------------------------------------------------- arranque
  (async function iniciar() {
    if (!window.Sesion) return estado('No se pudo cargar el inicio de sesión. Recarga la página.', false);
    cliente = await Sesion.cliente();
    if (!cliente) return estado('El inicio de sesión no está disponible.', false);
    const { data } = await cliente.auth.getSession();
    if (!data || !data.session) return estado('Entra con tu cuenta de Google de administrador.', true);
    const { data: esAdmin, error } = await cliente.rpc('es_admin');
    if (error || esAdmin !== true) return estado('Esta cuenta no es administradora. Entra con la cuenta correcta.', true);
    $('panelEstado').hidden = true;
    $('panel').hidden = false;
    await Promise.all([cargarResumen(), cargarPedidos(), cargarSaldo(), cargarRevision(), cargarManuales().catch(() => {}), cargarAlarma().catch(() => {}), cargarModoFF().catch(() => {}), cargarHojas().catch(() => {}), cargarMantenimiento().catch(() => {}), cargarPorAprobar().catch(() => {})]);
    escuchar();
  })();
})();
