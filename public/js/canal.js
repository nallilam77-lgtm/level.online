// Invitaciones al canal de WhatsApp de Level Up en las tiendas. El enlace y los textos viven solo aquí.
//
//   <div data-canal="exito"></div>            pantalla de recarga exitosa (el cliente está contento)
//   <div data-canal="ruleta" hidden></div>    debajo de la ruleta; Canal.mostrar('ruleta') cuando sale "Vacío"
//   <div data-canal="tienda"></div>           franja al final de la página (fuera del paso de pago)
//
// Siempre se abre en otra pestaña: el cliente no pierde su compra ni su pantalla de éxito.
(function () {
  const URL_CANAL = 'https://whatsapp.com/channel/0029Vb82z5017En51RN1NH1v';
  const ICONO = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>';

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
