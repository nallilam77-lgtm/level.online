// Datos de Pago Móvil que ven los clientes (las 7 tiendas y el perfil).
// Desde 2026-11-15 salen de Supabase: configuracion "pago_movil" (publico), que se arma en
// admin.html → Pagos → "Pago Móvil que ven los clientes":
//   { banco, telefono, cedula,            ← la cuenta predeterminada (lo que leían las páginas viejas)
//     cuentas: [{ banco, telefono, cedula, aviso }], predeterminada: i }   ← las que se muestran
// Con dos o más cuentas, DatosPago.selector() pinta "¿A qué banco pagas?" con la predeterminada marcada y
// el aviso de cada una. Con `condicion` (desde 2026-11-15, p. ej. "No aceptamos pagos desde UBI ni Mercantil…")
// pinta el aviso y una casilla `casilla` que el cliente debe marcar: hasta entonces los datos de pago quedan
// OCULTOS (no difuminados: css/ligero.css quita los filtros en celulares). Se recuerda en el equipo
// (localStorage) mientras el texto de la condición no cambie.
// Si Supabase no responde, se usa la copia vieja de Firestore (configuracion/pago_movil) para que la
// página nunca quede sin datos de pago. Sin SDK: un fetch a la API REST (la página no espera librerías).
(function () {
  const CLAVE_CONFIG = 'levelup_sesion_config';   // la misma que js/sesion.js (URL y llave pública de Supabase)
  const PROYECTO = 'levelupstore-87d4d';
  const CLAVE_WEB = 'AIzaSyBIdEh_HzzB8dnzG8qkPQYOIo2kSb_F6xQ'; // clave pública de la app web de Firebase
  const URL_FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents/configuracion/pago_movil?key=${CLAVE_WEB}`;
  const CSS = '/css/datos-pago.css?v=2';
  const CLAVE_ACEPTA = 'levelup_acepta_pago';   // texto de la condición que el cliente ya aceptó en este equipo

  // Las tiendas pintan estos datos con innerHTML: solo letras, números, espacios y . - ( ) /
  const limpio = (v, max = 60) => String(v ?? '').replace(/[^\p{L}\p{N} .,\-()/]/gu, '').trim().slice(0, max);
  const cuenta = (d) => ({ banco: limpio(d && d.banco), telefono: limpio(d && d.telefono), cedula: limpio(d && d.cedula), aviso: limpio(d && d.aviso, 160) });
  const completa = (c) => !!(c.banco && c.telefono && c.cedula);

  // { banco, telefono, cedula, cuentas, predeterminada } con la predeterminada arriba, o null
  function armar(valor) {
    const unica = cuenta(valor);
    let cuentas = Array.isArray(valor && valor.cuentas) ? valor.cuentas.slice(0, 4).map(cuenta).filter(completa) : [];
    let predeterminada = Number(valor && valor.predeterminada) || 0;
    if (!cuentas.length) { cuentas = completa(unica) ? [unica] : []; predeterminada = 0; }
    if (!cuentas.length) return null;
    if (!cuentas[predeterminada]) predeterminada = 0;
    const p = cuentas[predeterminada];
    return {
      banco: p.banco, telefono: p.telefono, cedula: p.cedula, cuentas, predeterminada,
      // Se pintan con textContent: basta con quitar los caracteres de control y cortar el largo
      condicion: String((valor && valor.condicion) || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 300),
      casilla: String((valor && valor.casilla) || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 200),
    };
  }

  function yaAcepto(texto) {
    try { return localStorage.getItem(CLAVE_ACEPTA) === texto; } catch (e) { return false; }
  }
  function guardarAcepto(texto) {
    try { localStorage.setItem(CLAVE_ACEPTA, texto); } catch (e) { /* sin almacenamiento: se pide cada vez */ }
  }

  async function configuracion() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CLAVE_CONFIG) || 'null');
      if (c && c.supabaseUrl) return c;
    } catch (e) { /* sigue */ }
    const c = await (await fetch('/api/version?config=1')).json();
    try { sessionStorage.setItem(CLAVE_CONFIG, JSON.stringify(c)); } catch (e) { /* sin almacenamiento */ }
    return c;
  }

  async function deSupabase() {
    const c = await configuracion();
    if (!c || !c.supabaseUrl || !c.supabaseKey) return null;
    const res = await fetch(`${c.supabaseUrl}/rest/v1/configuracion?select=valor&clave=eq.pago_movil`, {
      headers: { apikey: c.supabaseKey, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return armar(((await res.json())[0] || {}).valor);
  }

  async function deFirestore() {
    const res = await fetch(URL_FIRESTORE);
    if (!res.ok) return null;
    const campos = (await res.json()).fields || {};
    const texto = (nombre) => (campos[nombre] ? (campos[nombre].stringValue ?? campos[nombre].integerValue ?? '') : '');
    return armar({ banco: texto('banco'), telefono: texto('telefono'), cedula: texto('cedula') });
  }

  // Devuelve { banco, telefono, cedula, cuentas, predeterminada } o null si no hay forma de leerlos
  async function leer() {
    try {
      const d = await deSupabase();
      if (d) return d;
    } catch (e) { /* Supabase no respondió: copia de Firestore */ }
    try {
      return await deFirestore();
    } catch (e) {
      return null;
    }
  }

  function cargarCss() {
    if (document.querySelector('link[data-datos-pago]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = CSS;
    l.dataset.datosPago = '';
    document.head.appendChild(l);
  }

  // "Venezuela 0102" → "Venezuela"
  const nombreBanco = (banco) => banco.replace(/\s*\(?\d{4}\)?$/, '') || banco;

  // Aviso + casilla "acepto": hasta marcarla, `contenedor` (los datos de pago) queda oculto
  function cajaCondicion(condicion, casilla, contenedor) {
    const caja = document.createElement('div');
    caja.className = 'pm-condicion';
    const aviso = document.createElement('p');
    aviso.className = 'pm-condicion-texto';
    aviso.textContent = condicion;
    const etiqueta = document.createElement('label');
    etiqueta.className = 'pm-acepto';
    const marca = document.createElement('input');
    marca.type = 'checkbox';
    marca.checked = yaAcepto(condicion);
    const texto = document.createElement('span');
    texto.textContent = casilla || 'Entiendo y acepto';
    etiqueta.append(marca, texto);
    const bloqueo = document.createElement('p');
    bloqueo.className = 'pm-bloqueo';
    bloqueo.textContent = '🔒 Marca la casilla para ver los datos de pago.';
    const aplicar = () => {
      contenedor.classList.toggle('pm-oculto', !marca.checked);
      // "📋 Copiar todos los datos" de las tiendas (mismo id en las 7): tampoco sin aceptar
      const copiarTodo = document.getElementById('btnCopiarDatos');
      if (copiarTodo) copiarTodo.classList.toggle('pm-oculto', !marca.checked);
      bloqueo.hidden = marca.checked;
      caja.classList.toggle('pm-condicion--ok', marca.checked);
    };
    marca.addEventListener('change', () => {
      if (marca.checked) guardarAcepto(condicion);
      else guardarAcepto('');
      aplicar();
    });
    caja.append(aviso, etiqueta, bloqueo);
    aplicar();
    return caja;
  }

  /**
   * Pinta, justo antes de `contenedor`: el aviso con su casilla (si hay `condicion`) y los botones para
   * elegir a qué banco pagar (si hay 2 o más cuentas). Llama a alElegir(cuenta) con la predeterminada y
   * cada vez que el cliente cambia. Se puede volver a llamar: reemplaza lo anterior.
   */
  function selector(contenedor, datos, alElegir) {
    if (!contenedor || !datos) return;
    const anterior = contenedor.previousElementSibling;
    if (anterior && anterior.classList.contains('pm-elegir')) anterior.remove();
    const cuentas = datos.cuentas && datos.cuentas.length ? datos.cuentas : [datos];
    const inicial = cuentas[datos.predeterminada] || cuentas[0];
    const condicion = datos.condicion || '';
    if (cuentas.length > 1 || condicion) {
      cargarCss();
      const caja = document.createElement('div');
      caja.className = 'pm-elegir';
      if (condicion) caja.append(cajaCondicion(condicion, datos.casilla, contenedor));
      else contenedor.classList.remove('pm-oculto');
      if (cuentas.length > 1) {
        const titulo = document.createElement('p');
        titulo.className = 'pm-elegir-titulo';
        titulo.textContent = '¿A qué banco nos vas a pagar?';
        const opciones = document.createElement('div');
        opciones.className = 'pm-opciones';
        opciones.setAttribute('role', 'group');
        opciones.setAttribute('aria-label', 'Banco al que vas a pagar');
        const botones = cuentas.map((c) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'pm-opcion';
          b.textContent = nombreBanco(c.banco);
          b.setAttribute('aria-pressed', String(c === inicial));
          b.addEventListener('click', () => {
            botones.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
            alElegir(c);
          });
          return b;
        });
        opciones.append(...botones);
        caja.append(titulo, opciones);
        cuentas.filter((c) => c.aviso).forEach((c) => {
          const aviso = document.createElement('p');
          aviso.className = 'pm-aviso';
          aviso.textContent = c.aviso;
          caja.append(aviso);
        });
      }
      contenedor.parentNode.insertBefore(caja, contenedor);
    }
    alElegir(inicial);
  }

  window.DatosPago = { leer, selector };
})();
