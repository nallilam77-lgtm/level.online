// =========================================================================
// CÓDIGO DE DESCUENTO EN LAS TIENDAS (Free Fire y Blood Strike)
// Solo se envía el código: el servidor devuelve el catálogo con los precios ya descontados y,
// al recargar, vuelve a calcular el descuento por su cuenta (el navegador nunca decide el precio).
//
// Uso:
//   const descuento = CodigoDescuento.iniciar({
//     juego: 'freefire',                        // ?juego= de /api/juego
//     alAplicar: (catalogo) => { ... },         // dibujar el catálogo con los precios descontados
//     alQuitar: () => { ... },                  // volver a los precios normales
//   });
//   descuento.codigo()  // código aplicado o null: se envía en la recarga como codigoDescuento
//
// Necesita en la página: #inputDescuento, #btnVerificarDescuento y #descuentoEstado
// (estilos en css/descuento.css).
// =========================================================================
(function () {
  const FORMATO = /^[A-Z0-9_-]{2,30}$/;

  function iniciar({ juego, alAplicar, alQuitar }) {
    const input = document.getElementById('inputDescuento');
    const boton = document.getElementById('btnVerificarDescuento');
    const estado = document.getElementById('descuentoEstado');
    let aplicado = null;

    const mostrar = (tipo, texto) => {
      estado.className = `descuento-estado ${tipo}`;
      estado.textContent = texto;
    };

    function quitar() {
      aplicado = null;
      input.disabled = false;
      input.value = '';
      boton.textContent = 'VERIFICAR';
      mostrar('', '');
      alQuitar();
      input.focus();
    }

    async function verificar() {
      // Con un código ya aplicado, el botón sirve para quitarlo
      if (aplicado) { quitar(); return; }

      // Al pegar es fácil arrastrar espacios o minúsculas: se limpian antes de validar
      const codigo = input.value.replace(/\s+/g, '').toUpperCase();
      input.value = codigo;
      if (!FORMATO.test(codigo)) {
        mostrar('error', 'Escribe un código válido (letras y números, sin espacios).');
        return;
      }

      boton.disabled = true;
      boton.textContent = '...';
      try {
        const res = await fetch(`/api/juego?juego=${encodeURIComponent(juego)}&accion=descuento`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo })
        });
        const data = await res.json();
        if (data.valido && Array.isArray(data.catalogo)) {
          aplicado = data.codigo;
          input.value = data.codigo;
          input.disabled = true;
          boton.textContent = 'QUITAR';
          mostrar('ok', `✅ Código ${data.codigo} aplicado: ${data.descripcion}.`);
          alAplicar(data.catalogo);
        } else {
          boton.textContent = 'VERIFICAR';
          mostrar('error', data.message || 'Ese código no existe o ya no está activo.');
        }
      } catch (e) {
        boton.textContent = 'VERIFICAR';
        mostrar('error', 'No pudimos verificar el código. Intenta de nuevo.');
      } finally {
        boton.disabled = false;
      }
    }

    boton.addEventListener('click', verificar);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); verificar(); }
    });

    return { codigo: () => aplicado };
  }

  window.CodigoDescuento = { iniciar };
})();
