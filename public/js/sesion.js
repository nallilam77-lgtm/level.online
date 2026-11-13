// =========================================================================
// SESIÓN DEL CLIENTE (opcional, con Google, en Supabase)
// - Pinta el botón "Entrar" / "Mi perfil" en cada [data-sesion] (lleva a perfil.html).
// - Con sesión, agrega el token a las compras (POST /api/recargar) para que la recarga quede en el
//   perfil (api/_lib/historial.js). Sin sesión, la compra va igual que siempre.
// - La librería de Supabase (~60 KB) solo se descarga en perfil.html o cuando hay que renovar el token:
//   quien no inició sesión no la descarga nunca.
// Uso: <script src="/js/sesion.js?v=1" defer></script> + <link rel="stylesheet" href="css/sesion.css?v=1">
// API: Sesion.cliente() (Supabase o null), Sesion.entrar(), Sesion.salir(), Sesion.datos() (usuario guardado)
// =========================================================================
(function () {
  const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
  const CLAVE_CONFIG = 'levelup_sesion_config';
  let promesaCliente = null;

  // Sesión que Supabase guarda en el equipo ("sb-<proyecto>-auth-token")
  function guardada() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/^sb-.+-auth-token$/.test(k)) {
          const s = JSON.parse(localStorage.getItem(k));
          return s && s.access_token ? s : null;
        }
      }
    } catch (e) { /* sin almacenamiento: sin sesión */ }
    return null;
  }

  async function configuracion() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CLAVE_CONFIG) || 'null');
      if (c) return c;
    } catch (e) { /* sigue */ }
    const res = await fetch('/api/version?config=1');
    const c = await res.json();
    try { sessionStorage.setItem(CLAVE_CONFIG, JSON.stringify(c)); } catch (e) { /* sin almacenamiento */ }
    return c;
  }

  function cargarScript(src) {
    return new Promise((ok, falla) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = ok; s.onerror = () => falla(new Error('No cargó ' + src));
      document.head.appendChild(s);
    });
  }

  function cliente() {
    if (!promesaCliente) {
      promesaCliente = (async () => {
        const c = await configuracion();
        if (!c || !c.supabaseUrl || !c.supabaseKey) return null;
        if (!window.supabase) await cargarScript(SDK);
        return window.supabase.createClient(c.supabaseUrl, c.supabaseKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
        });
      })().catch(() => { promesaCliente = null; return null; });
    }
    return promesaCliente;
  }

  const conTiempo = (promesa, ms) => Promise.race([promesa, new Promise((ok) => setTimeout(() => ok(null), ms))]);

  // Token vigente: el guardado si le queda más de 1 minuto; si no, Supabase lo renueva (máx. 4 s)
  async function token() {
    const s = guardada();
    if (!s) return '';
    if (Number(s.expires_at) * 1000 > Date.now() + 60000) return s.access_token;
    try {
      const c = await conTiempo(cliente(), 4000);
      if (!c) return '';
      const r = await conTiempo(c.auth.getSession(), 4000);
      return (r && r.data && r.data.session && r.data.session.access_token) || '';
    } catch (e) { return ''; }
  }

  // Las compras llevan el token (si hay sesión). Nunca frena la compra: sin token sale igual.
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async function (recurso, opciones) {
    try {
      const url = typeof recurso === 'string' ? recurso : (recurso && recurso.url) || '';
      const ruta = url.replace(location.origin, '');
      if (/^\/api\/recargar(\?|$)/.test(ruta) && guardada()) {
        const t = await token();
        if (t) {
          opciones = Object.assign({}, opciones);
          const cabeceras = new Headers(opciones.headers || (typeof recurso !== 'string' && recurso.headers) || {});
          cabeceras.set('Authorization', 'Bearer ' + t);
          opciones.headers = cabeceras;
        }
      }
    } catch (e) { /* la compra sigue sin sesión */ }
    return fetchOriginal(recurso, opciones);
  };

  function datos() {
    const s = guardada();
    if (!s || !s.user) return null;
    const m = s.user.user_metadata || {};
    return { nombre: m.full_name || m.name || '', correo: s.user.email || '', foto: m.avatar_url || m.picture || '' };
  }

  const ICONO_USUARIO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function pintarBotones() {
    const d = datos();
    document.querySelectorAll('[data-sesion]').forEach((el) => {
      const volver = encodeURIComponent(location.pathname + location.search);
      el.href = `/perfil.html?volver=${volver}`;
      el.classList.add('sesion-boton');
      el.classList.toggle('sesion-boton--activa', !!d);
      const primerNombre = d && d.nombre ? d.nombre.split(' ')[0] : '';
      el.setAttribute('aria-label', d ? 'Mi perfil' : 'Iniciar sesión');
      el.innerHTML = '';
      if (d && d.foto && /^https:\/\//.test(d.foto)) {
        const img = document.createElement('img');
        img.src = d.foto; img.alt = ''; img.width = 26; img.height = 26; img.referrerPolicy = 'no-referrer';
        img.onerror = () => { img.replaceWith(document.createRange().createContextualFragment(ICONO_USUARIO)); };
        el.appendChild(img);
      } else {
        el.insertAdjacentHTML('beforeend', ICONO_USUARIO);
      }
      const texto = document.createElement('span');
      texto.textContent = d ? (primerNombre || 'Mi perfil') : 'Entrar';
      el.appendChild(texto);
    });
  }

  async function entrar() {
    const c = await cliente();
    if (!c) throw new Error('El inicio de sesión no está disponible.');
    const { error } = await c.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + '/perfil.html' + location.search },
    });
    if (error) throw error;
  }

  async function salir() {
    const c = await cliente();
    if (c) await c.auth.signOut();
    pintarBotones();
  }

  window.Sesion = { cliente, entrar, salir, datos, token, hay: () => !!guardada(), pintar: pintarBotones };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pintarBotones);
  else pintarBotones();
  // Otra pestaña inició o cerró sesión
  window.addEventListener('storage', (e) => { if (e.key && /^sb-.+-auth-token$/.test(e.key)) pintarBotones(); });
})();
