// =========================================================================
// PANEL ADMIN (admin.html) sobre Supabase (desde 2026-11-13; el panel de Firebase se quitó). Pago Móvil sigue en
// Firebase y se cambia en la consola de Firebase.
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
    if (b.dataset.seccion === 'cuentas') cargarCuentas();
    if (b.dataset.seccion === 'creadores') cargarCodigos();
    if (b.dataset.seccion === 'precios') cargarPrecios();
    if (b.dataset.seccion === 'roblox') cargarRoblox();
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

  // Prueba en paralelo: lo que la hoja cobra distinto de Supabase (precios_diferencias)
  function pintarDiferencias(lista) {
    const ul = $('listaDiferencias');
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
