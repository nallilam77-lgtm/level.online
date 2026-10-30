// Invitaciones al canal de WhatsApp de Level Up en las tiendas. El enlace y los textos viven solo aquí.
//
//   <div data-canal="exito"></div>            pantalla de recarga exitosa (el cliente está contento)
//   <div data-canal="ruleta" hidden></div>    debajo de la ruleta; Canal.mostrar('ruleta') cuando sale "Vacío"
//   <div data-canal="tienda"></div>           franja al final de la página (fuera del paso de pago)
//
// Siempre se abre en otra pestaña: el cliente no pierde su compra ni su pantalla de éxito.
(function () {
  const URL_CANAL = 'https://whatsapp.com/channel/0029Vb82z5017En51RN1NH1v';
  const ICONO = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.031 0C5.385 0 0 5.383 0 12.029c0 2.124.553 4.195 1.605 6.01L.036 24l6.11-1.603c1.737 1.002 3.738 1.531 5.885 1.531 6.643 0 12.028-5.381 12.028-12.027C24.059 5.383 18.675 0 12.031 0zm3.565 17.27c-.54.269-3.187.584-3.557.584-.37 0-1.802-.234-4.225-2.656-2.424-2.425-2.657-3.856-2.657-4.226 0-.37.316-3.018.584-3.557.269-.54.912-.767 1.451-.497.54.269 1.433 3.493 1.433 3.864 0 .37-.197.808-.466 1.077-.466.466.269.269-.538.448-.179 1.077.359.627 1.614 1.882 2.241 2.241.628.359.808.09 1.077-.179.269-.269.808-.466 1.077-.466.37 0 3.595.892 3.864 1.432.27.539.043 1.182-.497 1.451z"/></svg>';

  const TEXTOS = {
    exito: { titulo: '¿Te gustó? Únete a la comunidad', texto: 'Eventos, regalos y códigos de descuento que solo publicamos en el canal.', boton: 'Unirme al canal' },
    ruleta: { titulo: 'La próxima puede ser tuya', texto: 'En el canal anunciamos más premios, eventos y regalos.', boton: 'Ver el canal' },
    tienda: { titulo: 'Códigos de descuento exclusivos', texto: 'Eventos, regalos y códigos que solo publicamos en nuestro canal de WhatsApp.', boton: 'Unirme' },
  };

  function dibujar(caja) {
    const datos = TEXTOS[caja.dataset.canal];
    if (!datos || caja.dataset.listo) return;
    caja.dataset.listo = '1';
    caja.classList.add('canal-cta', 'canal-cta--' + caja.dataset.canal);
    caja.innerHTML = `
      <div class="canal-cta-texto">
        <strong>${datos.titulo}</strong>
        <span>${datos.texto}</span>
      </div>
      <a class="canal-cta-boton" href="${URL_CANAL}" target="_blank" rel="noopener noreferrer">${ICONO}${datos.boton}</a>`;
  }

  window.Canal = {
    URL: URL_CANAL,
    mostrar(tipo) {
      document.querySelectorAll(`[data-canal="${tipo}"]`).forEach((caja) => { dibujar(caja); caja.hidden = false; });
    },
  };

  const iniciar = () => document.querySelectorAll('[data-canal]').forEach(dibujar);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
