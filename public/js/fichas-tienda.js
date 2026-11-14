// =========================================================================
// FICHAS DEL MINIJUEGO EN LAS TIENDAS (Free Fire, Blood Strike, Mobile Legends y Roblox)
// Debajo del precio de cada paquete muestra "+N 🎟️": las fichas de Lluvia de Diamantes que da esa
// recarga. Si el administrador le puso fichas a mano a ese paquete (admin.html → Precios), esas; si no,
// 1 por cada bsPorFicha Bs del precio que se ve, mínimo 1 (igual que el disparador juego_fichas_por_recarga).
// Cada tarjeta lleva su paquete en data-paquete. Usa el precio que se muestra, así que con descuento o premio cuenta el precio
// final. Encima de los paquetes pone un aviso con enlace al juego.
// No toca cómo cada tienda dibuja sus tarjetas: mira las ".product-card" que aparecen y les agrega la línea.
// Uso: <script src="/js/fichas-tienda.js?v=1" defer></script> + <link rel="stylesheet" href="css/fichas-tienda.css?v=1">
// =========================================================================
(function () {
  const CLAVE = 'levelup_ajustes_fichas';
  const JUEGO = (location.pathname.match(/\/(freefire|bloodstrike|mobilelegends|roblox)(\.html)?$/) || [])[1] || '';
  let bsPorFicha = 0;
  let aMano = {};   // { "110 Diamantes": 2 } de este juego

  // "12.345,67 Bs" → 12345.67
  const precioDe = (texto) => Number(String(texto || '').replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.')) || 0;

  function marcar(card) {
    if (!bsPorFicha || card.classList.contains('agotado')) return;
    const precio = precioDe((card.querySelector('.price-text') || {}).textContent);
    if (!precio) return;
    const paquete = card.dataset.paquete;
    const fijas = paquete && Object.prototype.hasOwnProperty.call(aMano, paquete) ? Number(aMano[paquete]) : null;
    if (fijas === 0) { const t = card.querySelector('.fichas-tag'); if (t) t.remove(); return; }   // no da fichas
    const fichas = fijas !== null ? fijas : Math.max(1, Math.floor(precio / bsPorFicha));
    const texto = `+${fichas} ficha${fichas === 1 ? '' : 's'} 🎟️`;
    let tag = card.querySelector('.fichas-tag');
    if (tag && tag.textContent === texto) return;
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'fichas-tag';
      tag.title = 'Fichas para jugar Lluvia de Diamantes (con tu sesión iniciada)';
      const caja = card.querySelector('.price-box');
      if (caja) caja.after(tag); else card.append(tag);
    }
    tag.textContent = texto;
  }

  function aviso(card) {
    if (document.querySelector('.fichas-aviso')) return;
    const rejilla = card.parentNode;
    if (!rejilla || !rejilla.parentNode) return;
    const a = document.createElement('a');
    a.className = 'fichas-aviso';
    a.href = '/minijuego.html';
    a.innerHTML = '<span aria-hidden="true">🎟️</span><span>Cada recarga con tu sesión da <strong>fichas</strong> para jugar <strong>Lluvia de Diamantes</strong> y ganar 341 💎</span><span aria-hidden="true">→</span>';
    rejilla.parentNode.insertBefore(a, rejilla);
  }

  function revisar() {
    const cards = document.querySelectorAll('.product-card');
    cards.forEach(marcar);
    if (cards.length) aviso(cards[0]);
  }

  async function iniciar() {
    let aj = null;
    try { aj = JSON.parse(sessionStorage.getItem(CLAVE) || 'null'); } catch (e) { /* sin almacenamiento */ }
    if (!aj) {
      try {
        const r = await (await fetch('/api/minijuego?accion=ajustes')).json();
        if (!r || !r.activo || !(r.bsPorFicha > 0)) return;   // juego apagado: no se muestra nada
        aj = { bsPorFicha: r.bsPorFicha, fichas: r.fichas || {} };
        try { sessionStorage.setItem(CLAVE, JSON.stringify(aj)); } catch (e) { /* sin almacenamiento */ }
      } catch (e) { return; }
    }
    bsPorFicha = Number(aj.bsPorFicha) || 0;
    aMano = (aj.fichas && aj.fichas[JUEGO]) || {};
    if (!bsPorFicha) return;
    revisar();
    // Las tiendas redibujan el catálogo (al cargar, con código de descuento o premio): se vuelve a marcar
    let pendiente = false;
    new MutationObserver(() => {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(() => { pendiente = false; revisar(); });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
