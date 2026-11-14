// =========================================================================
// MEJORES CLIENTES DEL DÍA Y DE LA SEMANA (inicio)
// Lee GET /api/ranking (Supabase, 5 min en la CDN) y lo pinta en [data-ranking].
// Si el ranking no está activo o falla, la sección se queda oculta: la tienda sigue igual.
// Uso: <section data-ranking hidden>…</section> + <script src="/js/ranking.js?v=1" defer></script>
// =========================================================================
(function () {
  const caja = document.querySelector('[data-ranking]');
  if (!caja) return;
  const lista = caja.querySelector('.ranking-lista');
  const pestanas = caja.querySelectorAll('[data-periodo]');
  let datos = null;

  const bs = (n) => Number(n || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function fila(f) {
    const li = document.createElement('li');
    li.className = 'ranking-fila' + (f.puesto <= 3 ? ' ranking-fila--' + f.puesto : '');

    const puesto = document.createElement('span');
    puesto.className = 'ranking-puesto';
    puesto.textContent = f.puesto;

    let foto;
    if (f.foto) {
      foto = document.createElement('img');
      foto.src = f.foto; foto.alt = ''; foto.loading = 'lazy'; foto.referrerPolicy = 'no-referrer';
      foto.width = 40; foto.height = 40;
    } else {
      foto = document.createElement('span');
      foto.setAttribute('aria-hidden', 'true');
      foto.textContent = (f.nombre || '?').charAt(0).toUpperCase();
    }
    foto.className = 'ranking-foto';

    const nombre = document.createElement('span');
    nombre.className = 'ranking-nombre';
    nombre.textContent = f.nombre;

    const cuenta = document.createElement('span');
    cuenta.className = 'ranking-cuenta';
    // Se ordena por bolívares recargados: eso va grande; la cantidad de recargas, debajo
    const total = document.createElement('strong');
    total.textContent = bs(f.total) + ' Bs';
    const n = document.createElement('small');
    n.textContent = f.recargas + (f.recargas === 1 ? ' recarga' : ' recargas');
    cuenta.append(total, n);

    li.append(puesto, foto, nombre, cuenta);
    return li;
  }

  function pintar(periodo) {
    pestanas.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.periodo === periodo)));
    const filas = (datos && datos[periodo]) || [];
    lista.replaceChildren();
    if (!filas.length) {
      const vacio = document.createElement('li');
      vacio.className = 'ranking-vacio';
      vacio.innerHTML = periodo === 'dia'
        ? 'Nadie en la tabla todavía hoy. <a href="/perfil.html">Inicia sesión</a> y recarga para ser el primero.'
        : 'Nadie en la tabla esta semana. <a href="/perfil.html">Inicia sesión</a> y recarga para ser el primero.';
      lista.append(vacio);
      return;
    }
    filas.forEach((f) => lista.append(fila(f)));
  }

  pestanas.forEach((b) => b.addEventListener('click', () => pintar(b.dataset.periodo)));

  fetch('/api/ranking')
    .then((r) => (r.ok ? r.json() : null))
    .then((r) => {
      if (!r || !r.activo) return;
      datos = r;
      // Si hoy no hay nadie pero en la semana sí, abre en "Esta semana"
      pintar(r.dia.length || !r.semana.length ? 'dia' : 'semana');
      caja.hidden = false;
    })
    .catch(() => { /* sin ranking: la sección sigue oculta */ });
})();
