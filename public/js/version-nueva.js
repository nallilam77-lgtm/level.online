// Pestañas viejas: el HTML nunca se guarda en caché (Vercel/Cloudflare lo entregan fresco), pero el
// celular deja la pestaña abierta días y al volver la restaura de memoria sin pedirla. Esta página
// recuerda la versión del despliegue con la que se abrió (GET /api/version) y, cada vez que el cliente
// vuelve a ella, la compara con la actual:
//   - página sin datos → se recarga sola (trae la versión nueva al instante)
//   - a mitad de compra (ID, referencia, comprobante, una ventana o el chat abiertos) → barra
//     "Hay una versión nueva · Actualizar"; nunca se le borra lo que escribió sin preguntar.
// Si /api/version falla o no responde, no pasa nada: la tienda sigue igual.
(function () {
  const RUTA = '/api/version';
  // No preguntar más de una vez por minuto (volver y salir de la pestaña varias veces seguidas)
  const ESPERA_ENTRE_REVISIONES_MS = 60 * 1000;
  const CLAVE_RECARGA = 'levelup_recargada_para';

  let versionDeLaPagina = '';
  let ultimaRevision = 0;
  let avisada = false;

  async function versionActual() {
    try {
      const respuesta = await fetch(RUTA, { cache: 'no-store' });
      if (!respuesta.ok) return '';
      const datos = await respuesta.json();
      return typeof datos.version === 'string' ? datos.version.slice(0, 80) : '';
    } catch (e) {
      return '';
    }
  }

  // ¿El cliente está a mitad de algo que una recarga le borraría?
  function ocupado() {
    const conValor = (id) => {
      const el = document.getElementById(id);
      return !!(el && ((el.files && el.files.length) || String(el.value || '').trim()));
    };
    if (['inputPlayerId', 'inputZona', 'inputReferencia', 'inputComprobante'].some(conValor)) return true;
    if (window.chatFileOverride) return true;
    const chat = document.getElementById('chatModalWindow');
    if (chat && chat.classList.contains('active')) return true;
    return [...document.querySelectorAll('.overlay-pantalla')].some((el) => getComputedStyle(el).display !== 'none');
  }

  function mostrarBarra() {
    if (avisada) return;
    avisada = true;
    const estilo = document.createElement('style');
    // Acento de la tienda (o el cian de Level Up en inicio); ver .claude/UI_RULES.md
    estilo.textContent = `
      .version-nueva { position: fixed; top: calc(12px + env(safe-area-inset-top)); left: 50%; transform: translateX(-50%);
        z-index: 30000; width: min(420px, calc(100vw - 32px)); display: flex; align-items: center; gap: 12px;
        padding: 10px 10px 10px 16px; border-radius: 16px; background: var(--surface); color: var(--text-main);
        backdrop-filter: blur(var(--glass-blur, 12px)); -webkit-backdrop-filter: blur(var(--glass-blur, 12px));
        border: 1px solid rgba(var(--game-accent-rgb, 34, 211, 238), 0.5);
        box-shadow: var(--shadow-lg), 0 10px 25px -5px rgba(var(--game-accent-rgb, 34, 211, 238), 0.3);
        font-family: 'Poppins', sans-serif; font-size: 12px; font-weight: 600; line-height: 1.35; }
      .version-nueva::before { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: var(--bg-deep); opacity: 0.85; }
      .version-nueva span { flex: 1; }
      .version-nueva button { flex-shrink: 0; min-height: 44px; padding: 0 16px; border: none; border-radius: 12px; cursor: pointer;
        background: var(--cta-gradient, var(--accent-cyan)); color: var(--on-cta, var(--bg-base));
        font-family: 'Montserrat', sans-serif; font-weight: 900; font-size: 12px; text-transform: uppercase; }`;
    document.head.appendChild(estilo);
    const barra = document.createElement('div');
    barra.className = 'version-nueva';
    barra.setAttribute('role', 'status');
    barra.innerHTML = '<span>Hay una versión nueva de la tienda.</span><button type="button">Actualizar</button>';
    barra.querySelector('button').addEventListener('click', () => location.reload());
    document.body.appendChild(barra);
  }

  async function revisar() {
    if (!versionDeLaPagina || document.visibilityState !== 'visible') return;
    if (Date.now() - ultimaRevision < ESPERA_ENTRE_REVISIONES_MS) return;
    ultimaRevision = Date.now();
    const nueva = await versionActual();
    if (!nueva || nueva === versionDeLaPagina) return;

    // Nunca recargar dos veces por la misma versión (si algo raro devolviera el HTML viejo, no hay bucle)
    let yaRecargada = false;
    try { yaRecargada = sessionStorage.getItem(CLAVE_RECARGA) === nueva; } catch (e) { /* sin almacenamiento */ }
    if (ocupado() || yaRecargada) return mostrarBarra();
    try { sessionStorage.setItem(CLAVE_RECARGA, nueva); } catch (e) { /* sin almacenamiento */ }
    location.reload();
  }

  // La versión con la que se abrió: después de lo importante de la página (precios, verificación)
  window.addEventListener('load', () => {
    setTimeout(async () => { versionDeLaPagina = await versionActual(); }, 3000);
  });
  document.addEventListener('visibilitychange', revisar);
  // Pestaña restaurada desde la memoria (botón atrás o al volver a la app del navegador)
  window.addEventListener('pageshow', (e) => { if (e.persisted) revisar(); });
})();
