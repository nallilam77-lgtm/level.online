// =========================================================================
// INSTALAR LEVEL UP COMO APP (inicio): registra sw.js y muestra una tarjeta para agregar la tienda a la
// pantalla de inicio del teléfono.
//   - Android (Chrome): botón "Instalar" con el aviso del navegador (beforeinstallprompt).
//   - iPhone (Safari): no hay botón posible; se explica "Compartir → Agregar a inicio".
// No se muestra si ya está instalada, ni durante 30 días después de tocar "Ahora no".
// Necesita en la página: <div data-instalar-app></div> (estilos en css/instalar-app.css).
// =========================================================================
(function () {
  const CLAVE = 'levelup_instalar_cerrado';
  const PAUSA_MS = 30 * 24 * 60 * 60 * 1000;
  let aviso = null;

  if ('serviceWorker' in navigator && /^(www\.)?levelupstore\.online$|^localhost$|^127\.0\.0\.1$/.test(location.hostname)) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  const instalada = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const enPausa = () => {
    try { return Date.now() - Number(localStorage.getItem(CLAVE) || 0) < PAUSA_MS; } catch (e) { return false; }
  };
  const esIphone = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);

  const ICONO = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v7m-3-3 3 3 3-3M10 18h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function mostrar(modo) {
    const lugar = document.querySelector('[data-instalar-app]');
    if (!lugar || instalada() || enPausa()) return;
    lugar.className = 'instalar-app';
    lugar.hidden = false;
    lugar.innerHTML = `
      <span class="instalar-app__icono">${ICONO}</span>
      <div class="instalar-app__texto">
        <strong>Instala Level Up en tu teléfono</strong>
        <span>${modo === 'iphone'
          ? 'En Safari toca <b>Compartir</b> (el cuadro con la flecha) y luego <b>Agregar a inicio</b>.'
          : 'Ábrela desde tu pantalla de inicio, como una app, sin buscarnos.'}</span>
      </div>
      <div class="instalar-app__botones">
        ${modo === 'android' ? '<button type="button" class="instalar-app__btn instalar-app__btn--principal" data-instalar>Instalar</button>' : ''}
        <button type="button" class="instalar-app__btn" data-cerrar>Ahora no</button>
      </div>`;
    lugar.querySelector('[data-cerrar]').addEventListener('click', () => {
      try { localStorage.setItem(CLAVE, String(Date.now())); } catch (e) {}
      lugar.hidden = true;
    });
    lugar.querySelector('[data-instalar]')?.addEventListener('click', async () => {
      if (!aviso) return;
      aviso.prompt();
      const { outcome } = await aviso.userChoice.catch(() => ({}));
      aviso = null;
      if (outcome === 'accepted') lugar.hidden = true;
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    aviso = e;
    mostrar('android');
  });
  window.addEventListener('appinstalled', () => {
    const lugar = document.querySelector('[data-instalar-app]');
    if (lugar) lugar.hidden = true;
  });
  if (esIphone) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mostrar('iphone'));
    else mostrar('iphone');
  }
})();
