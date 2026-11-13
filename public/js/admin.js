// =========================================================================
// PANEL ADMIN (admin.html) sobre Supabase (desde 2026-11-13; antes Firebase).
// Entra con la sesión de Google de la tienda (js/sesion.js) y solo funciona si la cuenta está en la tabla
// "administradores": la base lo comprueba en cada consulta (RLS y es_admin(), supabase/tienda.sql), así
// que esta página no protege nada por sí sola. Secciones: resumen de ventas (admin_resumen), pedidos en
// vivo (tabla "recargas"), datos de Pago Móvil (tabla "configuracion") y ranking del minijuego
// (juego_revision). Todo lo que viene de la base se pinta con textContent.
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

  // ---------------------------------------------------------------- Pago Móvil
  async function cargarPago() {
    const { data, error } = await cliente.from('configuracion').select('valor').eq('clave', 'pago_movil').maybeSingle();
    if (error) { $('pagoMensaje').textContent = 'No se pudieron leer los datos.'; return; }
    const v = (data && data.valor) || {};
    $('pagoBanco').value = v.banco || '';
    $('pagoTelefono').value = v.telefono || '';
    $('pagoCedula').value = v.cedula || '';
  }

  $('formPago').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const valor = { banco: $('pagoBanco').value.trim(), telefono: $('pagoTelefono').value.trim(), cedula: $('pagoCedula').value.trim() };
    if (!valor.banco || !valor.telefono || !valor.cedula) return;
    if (!confirm(`¿Guardar estos datos? Los clientes pagarán aquí:\n\n${valor.banco}\n${valor.telefono}\n${valor.cedula}`)) return;
    const boton = ev.submitter || ev.target.querySelector('button');
    boton.disabled = true;
    const { error } = await cliente.from('configuracion')
      .upsert({ clave: 'pago_movil', valor, publico: true, actualizado: new Date().toISOString() }, { onConflict: 'clave' });
    boton.disabled = false;
    $('pagoMensaje').textContent = error ? 'No se pudo guardar: ' + error.message : '✅ Guardado. Las tiendas ya muestran los datos nuevos.';
  });

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
    await Promise.all([cargarResumen(), cargarPedidos(), cargarPago()]);
    escuchar();
  })();
})();
