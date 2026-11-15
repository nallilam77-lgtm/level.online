// Datos de Pago Móvil que ven los clientes (las 7 tiendas y el perfil).
// Desde 2026-11-15 salen de Supabase: configuracion "pago_movil" (publico), que se arma en
// admin.html → Pagos → "Pago Móvil que ven los clientes":
//   { banco, telefono, cedula,            ← la cuenta predeterminada (lo que leían las páginas viejas)
//     cuentas: [{ banco, telefono, cedula, aviso }], predeterminada: i }   ← las que se muestran
// Con dos o más cuentas, DatosPago.selector() pinta "¿A qué banco pagas?" con la predeterminada marcada y
// el aviso de cada una. Con `nota` (opcional, se escribe en el panel) pinta esa nota arriba de los bancos.
// (La "condición + casilla" que ocultaba los datos hasta aceptarla se quitó el 2026-11-15.)
// Si Supabase no responde, se usa la copia vieja de Firestore (configuracion/pago_movil) para que la
// página nunca quede sin datos de pago. Sin SDK: un fetch a la API REST (la página no espera librerías).
(function () {
  const CLAVE_CONFIG = 'levelup_sesion_config';   // la misma que js/sesion.js (URL y llave pública de Supabase)
  const PROYECTO = 'levelupstore-87d4d';
  const CLAVE_WEB = 'AIzaSyBIdEh_HzzB8dnzG8qkPQYOIo2kSb_F6xQ'; // clave pública de la app web de Firebase
  const URL_FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents/configuracion/pago_movil?key=${CLAVE_WEB}`;
  const CSS = '/css/datos-pago.css?v=3';

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
      nota: String((valor && valor.nota) || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 300),
    };
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

  /**
   * Pinta, justo antes de `contenedor`: la nota para el cliente (si hay) y los botones para elegir a qué
   * banco pagar (si hay 2 o más cuentas). Llama a alElegir(cuenta) con la predeterminada y cada vez que
   * el cliente cambia. Se puede volver a llamar: reemplaza lo anterior.
   */
  function selector(contenedor, datos, alElegir) {
    if (!contenedor || !datos) return;
    const anterior = contenedor.previousElementSibling;
    if (anterior && anterior.classList.contains('pm-elegir')) anterior.remove();
    const cuentas = datos.cuentas && datos.cuentas.length ? datos.cuentas : [datos];
    const inicial = cuentas[datos.predeterminada] || cuentas[0];
    if (cuentas.length > 1 || datos.nota) {
      cargarCss();
      const caja = document.createElement('div');
      caja.className = 'pm-elegir';
      if (datos.nota) {
        const nota = document.createElement('p');
        nota.className = 'pm-nota';
        nota.textContent = datos.nota;
        caja.append(nota);
      }
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
