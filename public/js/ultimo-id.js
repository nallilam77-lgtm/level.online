// Último ID confirmado en cada juego, guardado en ESTE dispositivo (localStorage). Lo usan las tiendas para
// escribirlo solo al volver y el chat para ofrecer "recargar a mi último ID". Nunca sale del navegador.
//
//   UltimoId.guardar('freefire', { id: '123456789', nombre: 'Jugador' })     // al confirmar el ID
//   UltimoId.guardar('mobilelegends', { id: '123456789', zona: '1234' })
//   UltimoId.leer('freefire')   -> { id, zona?, nombre?, fecha } o null
//   UltimoId.olvidar('freefire')
//
// Cada juego por separado: un ID de Free Fire no sirve en Blood Strike. Si el navegador bloquea el
// almacenamiento (modo privado, sin espacio), todo sigue funcionando sin recordar nada.
(function () {
  const CLAVE = 'levelup_ultimo_id';
  // Pasado este tiempo sin recargar, ya no se ofrece (pudo ser el ID de otra persona en un equipo prestado)
  const VIGENCIA_MS = 90 * 24 * 60 * 60 * 1000;
  const TEXTO = /^[A-Za-z0-9_]{1,30}$/;

  function leerTodo() {
    try {
      const datos = JSON.parse(localStorage.getItem(CLAVE) || '{}');
      return datos && typeof datos === 'object' ? datos : {};
    } catch (e) {
      return {};
    }
  }

  function escribirTodo(datos) {
    try { localStorage.setItem(CLAVE, JSON.stringify(datos)); } catch (e) { /* sin almacenamiento: no se recuerda */ }
  }

  window.UltimoId = {
    leer(juego) {
      const guardado = leerTodo()[juego];
      if (!guardado || !TEXTO.test(String(guardado.id || '')) || Date.now() - Number(guardado.fecha || 0) > VIGENCIA_MS) return null;
      return {
        id: String(guardado.id),
        zona: TEXTO.test(String(guardado.zona || '')) ? String(guardado.zona) : '',
        nombre: typeof guardado.nombre === 'string' ? guardado.nombre.slice(0, 60) : '',
        fecha: Number(guardado.fecha),
      };
    },
    guardar(juego, { id, zona = '', nombre = '' }) {
      if (!TEXTO.test(String(id || ''))) return;
      const datos = leerTodo();
      datos[juego] = { id: String(id), zona: String(zona || ''), nombre: String(nombre || '').slice(0, 60), fecha: Date.now() };
      escribirTodo(datos);
    },
    olvidar(juego) {
      const datos = leerTodo();
      delete datos[juego];
      escribirTodo(datos);
    },
  };
})();
