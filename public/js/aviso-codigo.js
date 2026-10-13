// =========================================================================
// MINI ANUNCIO "USA UN CÓDIGO DE CREADOR" (Free Fire, Blood Strike y Roblox)
// Burbuja pequeña encima del botón de WhatsApp (abajo a la izquierda). Al tocarla lleva al
// campo #inputDescuento; la X la cierra por 3 días.
// Para no estorbar se oculta sola cuando:
//   - el campo del código está a la vista (ya no hace falta señalarlo),
//   - ya hay un código aplicado (el campo queda deshabilitado),
//   - hay un modal abierto (body.modal-abierto) o el chat de IA está abierto.
// Estilos en css/aviso-codigo.css. Si la página no tiene #inputDescuento, no hace nada.
// =========================================================================
(function () {
  const CLAVE_CERRADO = 'aviso_codigo_cerrado';
  const DIAS_CERRADO = 3;
  const RETRASO_MS = 5000; // deja ver la página antes de mostrar nada

  function cerradoHace() {
    try { return Date.now() - Number(localStorage.getItem(CLAVE_CERRADO) || 0); }
    catch (e) { return Infinity; }
  }

  function iniciar() {
    const input = document.getElementById('inputDescuento');
    if (!input || cerradoHace() < DIAS_CERRADO * 86400000) return;

    const aviso = document.createElement('aside');
    aviso.className = 'aviso-codigo';
    aviso.setAttribute('aria-label', 'Ahorra con un código de creador');
    aviso.innerHTML =
      '<button type="button" class="aviso-codigo-abrir">' +
        '<span class="aviso-codigo-icono" aria-hidden="true">🎟️</span>' +
        '<span class="aviso-codigo-texto"><strong>Paga 1,5 % menos</strong>Usa un código de creador</span>' +
      '</button>' +
      '<button type="button" class="aviso-codigo-cerrar" aria-label="Cerrar anuncio">✕</button>';
    document.body.appendChild(aviso);

    let campoVisible = false;
    let cerrado = false;
    let listo = false;

    function actualizar() {
      const chatAbierto = document.querySelector('.chat-modal-window.active');
      const mostrar = listo && !cerrado && !campoVisible && !input.disabled &&
        !document.body.classList.contains('modal-abierto') && !chatAbierto;
      aviso.classList.toggle('visible', mostrar);
    }

    aviso.querySelector('.aviso-codigo-abrir').addEventListener('click', () => {
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Sin preventScroll el teclado del celular saltaría antes de terminar el desplazamiento
      setTimeout(() => input.focus({ preventScroll: true }), 400);
    });

    aviso.querySelector('.aviso-codigo-cerrar').addEventListener('click', () => {
      cerrado = true;
      try { localStorage.setItem(CLAVE_CERRADO, String(Date.now())); } catch (e) { /* sin almacenamiento: solo esta visita */ }
      actualizar();
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entradas) => {
        campoVisible = entradas[0].isIntersecting;
        actualizar();
      }).observe(input);
    }
    // Código aplicado (input deshabilitado), modales y chat: se vigilan sin tocar el código de cada página
    const vigilante = new MutationObserver(actualizar);
    vigilante.observe(input, { attributes: true, attributeFilter: ['disabled'] });
    vigilante.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const chat = document.getElementById('chatModalWindow');
    if (chat) vigilante.observe(chat, { attributes: true, attributeFilter: ['class'] });

    setTimeout(() => { listo = true; actualizar(); }, RETRASO_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
