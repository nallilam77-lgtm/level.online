// WhatsApp opcional del cliente y avisos de la ventana "CONFIRMA TU PEDIDO" (las 4 tiendas).
//
//   <div id="campoWhatsapp"></div>                    // aquí se dibuja el campo (al final del pago)
//   WhatsappCliente.revisar()                         // false si escribió un número incompleto (lo marca)
//   WhatsappCliente.valor()                           // "+584141234567" o "" → se manda a /api/recargar
//   WhatsappCliente.prepararConfirmacion({ productoUnico })   // al abrir la ventana de confirmación
//   WhatsappCliente.notaExito()                       // en la pantalla de éxito
//
// Es opcional: vacío nunca bloquea la compra. Sin número, la confirmación avisa que soporte no podrá
// escribirle. Con productoUnico (pases, tarjetas, membresías) el cliente confirma que NO lo tiene activo
// antes de poder enviar. El número se recuerda en ESTE dispositivo (localStorage) y solo sale con el pedido.
(function () {
  const CLAVE = 'levelup_whatsapp';
  // Celulares de Venezuela sin el 0: Movilnet 416/426, Movistar 414/424, Digitel 412/422
  const CELULAR = /^4(12|14|16|22|24|26)\d{7}$/;
  const TEXTO_ERROR = 'Son 10 números y empieza por 412, 414, 416, 422, 424 o 426. Si prefieres, déjalo vacío.';

  // "04141234567", "+58 414-123.4567" o "584141234567" → "4141234567" (lo demás se deja como está)
  function soloNumero(texto) {
    let digitos = String(texto || '').replace(/\D/g, '');
    // Ningún celular empieza por 58: con más de 10 cifras es el código del país
    if (digitos.length > 10 && digitos.startsWith('58')) digitos = digitos.slice(2);
    if (digitos.startsWith('0')) digitos = digitos.slice(1);
    return digitos.slice(0, 10);
  }

  // "4141234567" → "+58 414 123 4567"
  const legible = (digitos) => `+58 ${digitos.slice(0, 3)} ${digitos.slice(3, 6)} ${digitos.slice(6)}`;

  function leerGuardado() {
    try {
      const guardado = soloNumero(localStorage.getItem(CLAVE));
      return CELULAR.test(guardado) ? guardado : '';
    } catch (e) {
      return '';
    }
  }

  function guardar(digitos) {
    try {
      if (CELULAR.test(digitos)) localStorage.setItem(CLAVE, digitos);
      else if (!digitos) localStorage.removeItem(CLAVE);
    } catch (e) { /* sin almacenamiento: no se recuerda */ }
  }

  const entrada = () => document.getElementById('inputWhatsapp');
  const digitosActuales = () => soloNumero(entrada() ? entrada().value : '');

  function marcar(estado) {
    const caja = document.querySelector('.wa-cliente');
    const error = document.getElementById('waError');
    if (!caja || !error) return;
    caja.classList.toggle('valido', estado === 'valido');
    caja.classList.toggle('invalido', estado === 'invalido');
    error.hidden = estado !== 'invalido';
    entrada().setAttribute('aria-invalid', estado === 'invalido' ? 'true' : 'false');
  }

  function dibujarCampo() {
    const contenedor = document.getElementById('campoWhatsapp');
    if (!contenedor || contenedor.dataset.listo) return;
    contenedor.dataset.listo = '1';
    contenedor.className = 'wa-cliente';
    contenedor.innerHTML = `
      <div class="wa-cliente-cabecera">
        <label class="wa-cliente-titulo" for="inputWhatsapp">Tu WhatsApp <span class="wa-cliente-opcional">(opcional)</span></label>
      </div>
      <div class="wa-cliente-campo">
        <span class="wa-cliente-prefijo" aria-hidden="true">+58</span>
        <input type="tel" id="inputWhatsapp" class="wa-cliente-input" inputmode="numeric" autocomplete="tel-national"
          placeholder="4141234567" maxlength="16" aria-describedby="waError waPorqueTexto">
      </div>
      <p class="wa-cliente-error" id="waError" hidden>${TEXTO_ERROR}</p>
      <div class="wa-cliente-porque">
        <button type="button" class="wa-cliente-porque-btn" aria-expanded="false" aria-controls="waPorqueTexto">¿Por qué pedimos tu número?</button>
        <span class="wa-cliente-burbuja" id="waPorqueTexto" role="tooltip">
          Solo para escribirte si algo sale mal con tu recarga: un ID equivocado, algo que ya tenías o un pago que no cuadra.
          Sin él, dependemos de que tú nos escribas. No enviamos publicidad ni lo compartimos.
        </span>
      </div>`;

    const input = entrada();
    input.value = leerGuardado();
    if (input.value) marcar('valido');

    input.addEventListener('input', () => {
      const digitos = soloNumero(input.value);
      if (input.value !== digitos) input.value = digitos;
      // Mientras escribe no se marca error; solo el ✓ cuando ya está completo
      marcar(CELULAR.test(digitos) ? 'valido' : null);
      if (CELULAR.test(digitos) || !digitos) guardar(digitos);
    });
    input.addEventListener('blur', () => {
      const digitos = digitosActuales();
      marcar(!digitos ? null : CELULAR.test(digitos) ? 'valido' : 'invalido');
    });

    // "¿Por qué...?": en computadora se ve al pasar el mouse (CSS); en el teléfono, al tocar
    const porque = contenedor.querySelector('.wa-cliente-porque');
    const boton = porque.querySelector('button');
    const abrir = (si) => { porque.classList.toggle('abierto', si); boton.setAttribute('aria-expanded', si ? 'true' : 'false'); };
    boton.addEventListener('click', (e) => { e.stopPropagation(); abrir(!porque.classList.contains('abierto')); });
    document.addEventListener('click', (e) => { if (!porque.contains(e.target)) abrir(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') abrir(false); });
  }

  function irAlCampo() {
    if (typeof window.cerrarModal === 'function') window.cerrarModal();
    const input = entrada();
    if (!input) return;
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => input.focus({ preventScroll: true }), 350);
  }

  // Crea una vez el elemento dentro de la ventana de confirmación
  function pieza(modal, clase, etiqueta, colocar) {
    let el = modal.querySelector('.' + clase);
    if (!el) {
      el = document.createElement(etiqueta);
      el.className = clase;
      colocar(el);
    }
    return el;
  }

  window.WhatsappCliente = {
    valor() {
      const digitos = digitosActuales();
      return CELULAR.test(digitos) ? '+58' + digitos : '';
    },

    revisar() {
      const digitos = digitosActuales();
      if (!digitos || CELULAR.test(digitos)) return true;
      marcar('invalido');
      irAlCampo();
      return false;
    },

    prepararConfirmacion({ productoUnico = false } = {}) {
      const modal = document.getElementById('modalConfirmacion');
      const resumen = modal && modal.querySelector('.resumen-box');
      if (!resumen) return;
      const digitos = CELULAR.test(digitosActuales()) ? digitosActuales() : '';

      const fila = pieza(modal, 'wa-resumen-fila', 'p', (el) => {
        el.classList.add('resumen-row');
        el.innerHTML = 'WhatsApp: <span></span>';
        resumen.appendChild(el);
      });
      fila.hidden = !digitos;
      fila.querySelector('span').textContent = digitos ? legible(digitos) : '';

      const avisos = pieza(modal, 'wa-confirmacion', 'div', (el) => resumen.insertAdjacentElement('afterend', el));
      avisos.innerHTML = '';

      if (productoUnico) {
        avisos.insertAdjacentHTML('beforeend', `
          <div class="wa-aviso wa-aviso-unico">
            <p>⚠️ Si ya tienes este pase o membresía <strong>activo</strong>, no se acumula y <strong>no hay reembolso</strong>.</p>
            <label class="wa-check"><input type="checkbox" id="waNoLoTengo"><span>Revisé mi cuenta y <strong>NO</strong> lo tengo activo</span></label>
          </div>`);
      }
      if (!digitos) {
        avisos.insertAdjacentHTML('beforeend', `
          <div class="wa-aviso wa-aviso-sin-numero">
            <p>📱 <strong>Sin tu WhatsApp</strong> no podremos avisarte si hay un problema con tu recarga.</p>
            <button type="button" class="wa-aviso-agregar">Agregar mi número</button>
          </div>`);
        avisos.querySelector('.wa-aviso-agregar').addEventListener('click', irAlCampo);
      }

      // Pase o membresía: "¡SÍ, ENVIAR!" se habilita solo al marcar la casilla
      const enviar = document.getElementById('btnConfirmar');
      const casilla = document.getElementById('waNoLoTengo');
      if (enviar && casilla) {
        enviar.disabled = true;
        casilla.addEventListener('change', () => { enviar.disabled = !casilla.checked; });
      }
    },

    notaExito() {
      const txn = document.getElementById('codigoTxnExito');
      if (!txn) return;
      let nota = document.querySelector('.wa-nota-exito');
      if (!nota) {
        nota = document.createElement('p');
        nota.className = 'wa-nota-exito';
        nota.innerHTML = '📌 <strong>Guarda este código TXN</strong> (captura de pantalla). Si algo no llega, escríbenos por WhatsApp con él.';
        txn.insertAdjacentElement('afterend', nota);
      }
      nota.hidden = !!this.valor();
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', dibujarCampo);
  else dibujarCampo();
})();
