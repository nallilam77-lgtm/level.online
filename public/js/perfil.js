// =========================================================================
// MI PERFIL (perfil.html): inicio de sesión con Google, datos del cliente, cliente fiel de la cuenta y
// "Mis recargas" con el estado EN VIVO (Supabase Realtime sobre la tabla "recargas", que el cliente solo
// puede leer: la escribe el servidor, api/_lib/historial.js).
// Tiendas manuales: el estado vive en la hoja; mientras el perfil está abierto se pregunta cada 60 s
// (accion=estado, que además actualiza Supabase) y el cambio llega por Realtime.
// =========================================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const JUEGOS = {
    freefire: 'Free Fire', bloodstrike: 'Blood Strike', mobilelegends: 'Mobile Legends', roblox: 'Roblox',
    fcmobile: 'FC Mobile', codmobile: 'COD Mobile', clashroyale: 'Clash Royale',
  };
  const MANUALES = ['fcmobile', 'codmobile', 'clashroyale'];
  const ESTADOS = {
    pendiente: 'Recibido', en_proceso: 'En proceso', completado: 'Entregada', incompleto: 'Pago incompleto',
    en_revision: 'En revisión', problema: 'Con problema', reembolsado: 'Reembolsada',
  };
  const ABIERTOS = ['pendiente', 'en_proceso', 'incompleto'];
  const WHATSAPP = '584141916377';
  const MAX_RECARGAS = 50;

  let cliente = null;
  let usuario = null;
  let recargas = [];
  let canal = null;
  let temporizador = null;

  // ---------------------------------------------------------------- utilidades
  // "12 nov. 2026, 11:47 p. m." (hora de Venezuela; la hora nunca se parte en dos líneas)
  const fechaHora = (iso) => {
    const d = new Date(iso);
    const fecha = d.toLocaleDateString('es-VE', { timeZone: 'America/Caracas', day: 'numeric', month: 'short', year: 'numeric' });
    const hora = d.toLocaleTimeString('es-VE', { timeZone: 'America/Caracas', hour: 'numeric', minute: '2-digit' });
    return `${fecha}, ${hora.replace(/\s/g, '\u00a0')}`;
  };
  const bs = (n) => (n == null ? '' : `${Number(n).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Bs`);
  function el(etiqueta, clase, texto) {
    const e = document.createElement(etiqueta);
    if (clase) e.className = clase;
    if (texto != null) e.textContent = texto;
    return e;
  }
  function mostrar(panel) {
    ['panelCargando', 'panelEntrar', 'panelPerfil', 'panelFiel', 'panelRecargas'].forEach((id) => { $(id).hidden = !panel.includes(id); });
  }
  // "Volver" a la tienda de donde vino (solo páginas propias)
  const parametros = new URLSearchParams(location.search);
  const volver = parametros.get('volver') || '';
  const volverValido = /^\/[a-z]+\.html$/.test(volver.split('?')[0]);
  if (volverValido) $('enlaceVolver').href = volver;
  // "&entrar=1" (lo manda minijuego.html, que exige sesión): con la sesión lista, regresa solo a esa página
  const regresarSolo = volverValido && parametros.get('entrar') === '1';

  // ---------------------------------------------------------------- recargas
  // Por qué falló una recarga, según Central One (failure.code; lo anota api/centralone-webhook.js)
  const MOTIVOS = {
    invalid_player: 'El ID no existe o no es de la región correcta. Escríbenos por WhatsApp con tu ID para resolverlo.',
    not_eligible: 'Tu cuenta no puede recibir este paquete (por ejemplo, ya tiene ese pase). Escríbenos por WhatsApp para cambiarlo o devolverte el pago.',
    out_of_stock: 'El proveedor se quedó sin este paquete justo ahora. Te la hacemos apenas vuelva o te devolvemos el pago.',
    provider_unavailable: 'El proveedor tuvo una falla momentánea. La estamos reintentando; te avisamos por WhatsApp.',
    provider_rejected: 'El proveedor rechazó la recarga. La estamos revisando; te avisamos por WhatsApp.',
    price_changed: 'El precio cambió mientras se procesaba. La estamos revisando; te avisamos por WhatsApp.',
  };
  const MOTIVO_GENERAL = 'Estamos revisando tu recarga; te avisamos por WhatsApp.';

  function tarjeta(r) {
    const li = el('li', 'recarga');
    li.dataset.juego = r.juego;
    li.dataset.id = r.id_pedido;

    const fila = el('div', 'recarga-fila');
    const izq = el('div');
    izq.append(el('span', 'recarga-juego', JUEGOS[r.juego] || r.juego), el('span', 'recarga-paquete', r.paquete));
    const der = el('div', 'recarga-derecha');
    der.append(el('span', 'recarga-precio', bs(r.precio)));
    fila.append(izq, der);

    const estado = el('span', `estado estado--${r.estado}`, ESTADOS[r.estado] || r.estado);
    const detalle = el('div', 'recarga-detalle');
    detalle.append(el('span', '', r.cuenta), el('span', '', fechaHora(r.creado)));
    if (r.referencia) detalle.append(el('span', '', `Referencia …${r.referencia}`));
    const filaEstado = el('div', 'recarga-fila');
    filaEstado.append(detalle, estado);

    li.append(fila, filaEstado);
    if (r.motivo_fallo && ['en_revision', 'problema'].includes(r.estado)) {
      li.append(el('p', 'recarga-motivo', MOTIVOS[r.motivo_fallo] || MOTIVO_GENERAL));
    }

    if (r.codigo) {
      const caja = el('div', 'recarga-codigo');
      caja.append(el('span', '', r.codigo));
      const copiar = el('button', 'btn-copiar-codigo', 'Copiar');
      copiar.type = 'button';
      copiar.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(r.codigo); copiar.textContent = '¡Copiado!'; } catch (e) { copiar.textContent = 'Mantén presionado'; }
      });
      caja.append(copiar);
      li.append(caja);
    }

    const acciones = el('div', 'recarga-acciones');
    const otra = el('a', '', 'Recargar de nuevo');
    otra.href = `/${r.juego}.html`;
    acciones.append(otra);
    if (['en_revision', 'problema', 'incompleto'].includes(r.estado)) {
      const ayuda = el('a', '', 'Escribir por WhatsApp');
      ayuda.href = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(`Hola Level Up, tengo una recarga de ${JUEGOS[r.juego]} (${r.paquete}, ${r.cuenta}${r.referencia ? `, referencia …${r.referencia}` : ''}) en estado "${ESTADOS[r.estado]}"${r.motivo_fallo ? ` (motivo: ${r.motivo_fallo})` : ''}.`)}`;
      ayuda.target = '_blank';
      ayuda.rel = 'noopener';
      acciones.append(ayuda);
    }
    li.append(acciones);
    return li;
  }

  function pintarRecargas(cambiado) {
    const lista = $('listaRecargas');
    lista.replaceChildren();
    if (!recargas.length) {
      const vacia = el('li', 'lista-vacia');
      vacia.innerHTML = 'Aún no tienes recargas con esta cuenta. Las que hagas con la sesión iniciada aparecerán aquí al momento. <a href="/index.html">Ir a la tienda</a>';
      lista.append(vacia);
    }
    recargas.forEach((r) => {
      const t = tarjeta(r);
      if (r.id_pedido === cambiado) {
        t.classList.add('recarga--cambio');
        setTimeout(() => t.classList.remove('recarga--cambio'), 2500);
      }
      lista.append(t);
    });
    $('totalRecargas').textContent = recargas.length;
    $('totalEntregadas').textContent = recargas.filter((r) => r.estado === 'completado').length;
  }

  async function cargarRecargas() {
    // Siempre filtrar por la cuenta: un administrador puede LEER todas las recargas (RLS de admin.html)
    // y sin este filtro vería en su perfil las de otros clientes
    const { data, error } = await cliente.from('recargas')
      .select('id_pedido,juego,cuenta,id_jugador,zona,paquete,precio,referencia,estado,codigo,creado,motivo_fallo')
      .eq('usuario', usuario.id)
      .order('creado', { ascending: false }).limit(MAX_RECARGAS);
    if (error) throw error;
    recargas = data || [];
    pintarRecargas();
  }

  // Cambios en vivo: solo llegan las filas de este cliente (RLS)
  function escuchar() {
    if (canal) cliente.removeChannel(canal);
    canal = cliente.channel(`recargas-${usuario.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recargas', filter: `usuario=eq.${usuario.id}` }, (cambio) => {
        const nueva = cambio.new;
        if (!nueva || !nueva.id_pedido) return;
        const i = recargas.findIndex((r) => r.id_pedido === nueva.id_pedido);
        if (i >= 0) recargas[i] = Object.assign({}, recargas[i], nueva);
        else recargas.unshift(nueva);
        recargas = recargas.slice(0, MAX_RECARGAS);
        pintarRecargas(nueva.id_pedido);
        pintarFiel();
      })
      .subscribe();
  }

  // Manuales abiertas (últimas 72 h, máx. 3): el servidor lee la hoja y actualiza Supabase
  async function revisarManuales() {
    if (document.hidden) return;
    const limite = Date.now() - 72 * 3600 * 1000;
    const abiertas = recargas.filter((r) => MANUALES.includes(r.juego) && ABIERTOS.includes(r.estado) && new Date(r.creado).getTime() > limite).slice(0, 3);
    for (const r of abiertas) {
      try {
        const res = await fetch(`/api/juego?juego=${r.juego}&accion=estado`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idPedido: r.id_pedido }),
        });
        const d = await res.json();
        if (d && d.status === 'success' && ESTADOS[d.estado] && d.estado !== r.estado) {
          r.estado = d.estado;
          pintarRecargas(r.id_pedido);
        }
      } catch (e) { /* se reintenta en la próxima vuelta */ }
    }
  }

  // ---------------------------------------------------------------- cliente fiel
  // Una sola tarjeta: el premio es de la cuenta (suman todas las tiendas automáticas, con cualquier ID).
  // La consulta lleva el token (sesion.js); se pregunta a Free Fire, pero el conteo es el mismo en todas.
  let consultandoFiel = false;
  async function pintarFiel() {
    if (consultandoFiel) return;
    consultandoFiel = true;
    let d = null;
    try {
      const res = await fetch('/api/juego?juego=freefire&accion=fidelidad', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const r = await res.json();
      d = r && r.status === 'success' && r.activo && r.sesion ? r : null;
    } catch (e) { d = null; }
    consultandoFiel = false;
    const lista = $('listaFiel');
    lista.replaceChildren();
    $('panelFiel').hidden = !d;
    if (!d) return;
    const cada = Number(d.cada) || 6;
    const hechas = d.premio > 0 ? cada - 1 : Math.max(0, cada - 1 - (Number(d.faltan) || 0));
    const li = el('li', 'fiel-item' + (d.premio > 0 ? ' fiel-item--premio' : ''));
    const cabeza = el('div', 'fiel-cabeza');
    const titulo = el('strong', '', 'Tu cuenta Level Up');
    const puntos = el('span', 'fiel-puntos');
    puntos.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < cada; i++) {
      puntos.append(el('span', `fiel-punto${i < hechas ? ' fiel-punto--lleno' : ''}${i === cada - 1 ? ' fiel-punto--premio' : ''}`));
    }
    cabeza.append(titulo, puntos);
    const texto = el('p', 'fiel-texto');
    texto.innerHTML = d.premio > 0
      ? '<strong>¡Tu próxima recarga tiene 1,5&nbsp;% de descuento!</strong> Se aplica sola en Free Fire, Blood Strike, Mobile Legends o Roblox con la sesión iniciada, para cualquier ID.'
      : `Llevas <strong>${hechas} de ${cada - 1}</strong> recargas. La n.º&nbsp;${cada} lleva 1,5&nbsp;% de descuento.`;
    li.append(cabeza, texto);
    lista.append(li);
  }

  // ---------------------------------------------------------------- WhatsApp de la cuenta (tabla perfiles)
  let telefono = '';
  function pintarTelefono() {
    $('telefonoPerfil').textContent = telefono ? telefono.replace(/^\+58(\d{3})(\d{7})$/, '0$1 $2') : 'Sin número';
    $('btnTelefono').textContent = telefono ? 'Cambiar' : 'Agregar';
    $('telefonoPerfil').parentElement.parentElement.classList.toggle('perfil-whatsapp--falta', !telefono);
  }
  async function cargarTelefono() {
    try {
      const { data } = await cliente.from('perfiles').select('telefono').eq('usuario', usuario.id).maybeSingle();
      telefono = (data && data.telefono) || '';
    } catch (e) { telefono = ''; }
    pintarTelefono();
  }
  window.addEventListener('telefono-cuenta', (e) => { telefono = e.detail || telefono; pintarTelefono(); });
  $('btnTelefono').addEventListener('click', async () => {
    const nuevo = await Sesion.cambiarTelefono(telefono);
    if (nuevo) { telefono = nuevo; pintarTelefono(); }
  });

  // ---------------------------------------------------------------- sesión
  async function conSesion(sesion) {
    if (regresarSolo) { location.replace(volver); return; }
    usuario = sesion.user;
    const m = usuario.user_metadata || {};
    $('nombrePerfil').textContent = m.full_name || m.name || 'Cliente Level Up';
    $('correoPerfil').textContent = usuario.email || '';
    if (/^https:\/\//.test(m.avatar_url || '')) $('fotoPerfil').src = m.avatar_url;
    mostrar(['panelPerfil', 'panelRecargas']);
    Sesion.pintar();
    cargarTelefono();
    // Recién iniciada la sesión aquí: sesion.js ya revisó al cargar la página (sin sesión todavía)
    if (Sesion.revisarTelefono) Sesion.revisarTelefono();
    try {
      await cargarRecargas();
    } catch (e) {
      $('listaRecargas').replaceChildren(el('li', 'lista-vacia', 'No pudimos cargar tus recargas. Revisa tu conexión y recarga la página.'));
    }
    escuchar();
    pintarFiel();
    revisarManuales();
    clearInterval(temporizador);
    temporizador = setInterval(revisarManuales, 60000);
  }

  function sinSesion() {
    usuario = null;
    recargas = [];
    clearInterval(temporizador);
    if (canal && cliente) { cliente.removeChannel(canal); canal = null; }
    mostrar(['panelEntrar']);
    Sesion.pintar();
  }

  $('btnGoogle').addEventListener('click', async () => {
    const boton = $('btnGoogle');
    boton.disabled = true;
    $('mensajeEntrar').textContent = '';
    try {
      await Sesion.entrar(); // lleva a Google y vuelve aquí
    } catch (e) {
      $('mensajeEntrar').textContent = 'No pudimos abrir el inicio de sesión. Intenta de nuevo en un momento.';
      boton.disabled = false;
    }
  });

  $('btnSalir').addEventListener('click', async () => {
    $('btnSalir').disabled = true;
    try { await Sesion.salir(); } finally { $('btnSalir').disabled = false; sinSesion(); }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden && usuario) revisarManuales(); });

  (async function iniciar() {
    cliente = await Sesion.cliente();
    if (!cliente) {
      mostrar(['panelEntrar']);
      $('btnGoogle').disabled = true;
      $('mensajeEntrar').textContent = 'El inicio de sesión aún no está disponible. Puedes comprar sin cuenta como siempre.';
      return;
    }
    // Al volver de Google, Supabase cambia el código de la dirección por la sesión (detectSessionInUrl)
    const { data } = await cliente.auth.getSession();
    if (data && data.session) conSesion(data.session); else sinSesion();
    cliente.auth.onAuthStateChange((evento, sesion) => {
      if (evento === 'SIGNED_OUT') sinSesion();
      else if (evento === 'SIGNED_IN' && sesion && (!usuario || usuario.id !== sesion.user.id)) conSesion(sesion);
    });
  })();
})();
