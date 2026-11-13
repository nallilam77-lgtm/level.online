// =========================================================================
// PANEL (panel.html) sobre Supabase (desde 2026-11-13). Pago Móvil sigue en Firebase: se cambia en admin.html.
// Entra con la sesión de Google de la tienda (js/sesion.js) y solo funciona si la cuenta está en la tabla
// "administradores": la base lo comprueba en cada consulta (RLS y es_admin(), supabase/tienda.sql), así
// que esta página no protege nada por sí sola. Secciones: resumen de ventas (admin_resumen), pedidos en
// vivo (tabla "recargas"), ranking del minijuego
// (juego_revision) y espacio de la base con limpieza de semanas viejas (admin_espacio / admin_borrar_viejo). Todo lo que viene de la base se pinta con textContent.
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
  const MAX_PEDIDOS = 100;
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

  // Inicio del día y de la semana (lunes) en Venezuela (UTC-4), como api/_lib/semana.js
  function iniciosVE(ahora = Date.now()) {
    const DIA = 864e5, DESFASE = 4 * 36e5;
    const dia = Math.floor((ahora - DESFASE) / DIA) * DIA;
    const lunes = dia - ((new Date(dia).getUTCDay() + 6) % 7) * DIA;
    return { dia: new Date(dia + DESFASE), semana: new Date(lunes + DESFASE), semanaPasada: new Date(lunes - 7 * DIA + DESFASE) };
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
    if (b.dataset.seccion === 'juego') cargarJuego();
    if (b.dataset.seccion === 'espacio') cargarEspacio();
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

  // ---------------------------------------------------------------- pedidos
  function tarjetaPedido(p, nuevo) {
    const li = el('li', 'pedido' + (nuevo ? ' pedido--nuevo' : ''));
    const cabeza = el('div', 'pedido-cabeza');
    cabeza.append(el('strong', '', `${JUEGOS[p.juego] || p.juego} · ${p.paquete}`), el('span', 'etiqueta etiqueta--' + p.estado, ESTADOS[p.estado] || p.estado));
    li.append(
      cabeza,
      el('span', '', `${p.cuenta}${p.precio ? ` · ${bs(p.precio)} Bs` : ''}${p.referencia ? ` · ref. …${p.referencia}` : ''}`),
      el('span', '', `${fecha(p.creado)}${p.usuario ? ' · con cuenta' : ''} · ${p.id_pedido}`),
    );
    return li;
  }

  function pintarPedidos(nuevoId) {
    const filtro = $('filtroEstado').value;
    const texto = $('buscar').value.trim().toLowerCase();
    const lista = $('listaPedidos');
    lista.replaceChildren();
    const visibles = pedidos.filter((p) => (!filtro || p.estado === filtro)
      && (!texto || [p.cuenta, p.paquete, p.referencia, p.id_pedido, JUEGOS[p.juego]].join(' ').toLowerCase().includes(texto)));
    if (!visibles.length) { lista.append(el('li', 'vacio', 'No hay pedidos con ese filtro.')); return; }
    visibles.forEach((p) => lista.append(tarjetaPedido(p, p.id_pedido === nuevoId)));
  }

  async function cargarPedidos() {
    const { data, error } = await cliente.from('recargas')
      .select('id_pedido,juego,cuenta,paquete,precio,referencia,estado,creado,usuario')
      .order('creado', { ascending: false }).limit(MAX_PEDIDOS);
    if (error) { console.error(error); $('listaPedidos').replaceChildren(el('li', 'vacio', 'No se pudieron cargar los pedidos.')); return; }
    pedidos = data || [];
    pintarPedidos();
  }
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
        pedidos = pedidos.slice(0, MAX_PEDIDOS);
        pintarPedidos(n.id_pedido);
        cargarResumen();
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
      cabeza.append(el('strong', '', `${f.puesto}. ${f.correo} · ${Number(f.puntos).toLocaleString('es-VE')} pts`));
      if (f.revisar) cabeza.append(el('span', 'etiqueta etiqueta--revisar', 'Revisar'));
      const st = f.stats || {};
      li.append(cabeza,
        el('span', '', `Mejor partida: ${f.segundos} s · atrapó ${st.atrapados ?? '?'} y se le escaparon ${st.escapados ?? '?'} · ${st.golpes ?? '?'} golpes`),
        el('span', '', `${f.partidas_validas} partidas válidas, ${f.partidas_invalidas} inválidas · ${fecha(f.terminada)}`));
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
    await Promise.all([cargarResumen(), cargarPedidos()]);
    escuchar();
  })();
})();
