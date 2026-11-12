// Tiendas de recarga MANUAL (fcmobile.html, codmobile.html, clashroyale.html). El juego sale de
// <body data-juego="...">. Flujo: elegir paquete → Pago Móvil → comprobante y referencia → "COMPRAR" →
// ventana con los datos de la cuenta (forma de iniciar sesión, correo, contraseña) y el WhatsApp
// obligatorio → /api/recargar?juego=... (api/_lib/juegos/manuales.js → apps-script/manuales.gs).
// La contraseña solo vive en el campo de la ventana: no se guarda en el equipo y se borra al terminar.
(function () {
  const JUEGO = document.body.dataset.juego;
  const API_PRECIOS = `/api/juego?juego=${encodeURIComponent(JUEGO)}&accion=precios`;
  const API_PEDIDO = `/api/recargar?juego=${encodeURIComponent(JUEGO)}`;
  // Mismo número que recuerda js/whatsapp-cliente.js en las otras tiendas (10 dígitos: 4141234567)
  const CLAVE_WHATSAPP = 'levelup_whatsapp';
  const CELULAR = /^4(12|14|16|22|24|26)\d{7}$/;
  const CORREO = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

  const $ = (id) => document.getElementById(id);
  let datosBanco = { banco: '', telefono: '', cedula: '' };
  let metodos = [];
  let paqueteSeleccionado = null;
  let enviando = false;

  // ---------- Utilidades ----------
  function burbuja(mensaje, error) {
    const b = $('toastBubble');
    b.textContent = mensaje;
    b.classList.toggle('error', !!error);
    b.classList.add('show');
    clearTimeout(burbuja.t);
    burbuja.t = setTimeout(() => b.classList.remove('show'), 3500);
  }

  // El precio llega de la hoja ya escrito en Bs ("1.250,50"): se muestra tal cual
  const textoBs = (valor) => `${valor} Bs`;

  function leerWhatsapp() {
    try { return localStorage.getItem(CLAVE_WHATSAPP) || ''; } catch (e) { return ''; }
  }
  function guardarWhatsapp(digitos) {
    try { localStorage.setItem(CLAVE_WHATSAPP, digitos); } catch (e) { /* modo privado */ }
  }
  // "0414-123.4567", "+58 414…" o "4141234567" → "4141234567" (o "" si no es un celular venezolano)
  function celular(valor) {
    let d = String(valor || '').replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('58')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return CELULAR.test(d) ? d : '';
  }

  // ---------- Datos de pago y catálogo ----------
  async function cargarDatosBanco() {
    const datos = await window.DatosPago?.leer();
    if (!datos) return;
    datosBanco = datos;
    const contenedor = $('bankInfoContainer');
    contenedor.replaceChildren();
    [['banco', 'Banco'], ['telefono', 'Teléfono'], ['cedula', 'Cédula']].forEach(([campo, etiqueta]) => {
      const fila = document.createElement('div');
      fila.className = 'bank-row';
      const valor = document.createElement('span');
      valor.className = 'bank-value';
      valor.textContent = datos[campo];
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'btn-mini-copy';
      boton.setAttribute('aria-label', `Copiar ${etiqueta.toLowerCase()}`);
      boton.textContent = '📋';
      boton.addEventListener('click', () => copiar(datos[campo], etiqueta, boton));
      fila.append(`${etiqueta}:`, valor, boton);
      contenedor.appendChild(fila);
    });
  }

  async function cargarCatalogo() {
    const contenedor = $('catalogContainer');
    const mensaje = (texto, error) => {
      contenedor.innerHTML = '';
      const div = document.createElement('div');
      div.className = 'catalog-message' + (error ? ' error' : '');
      div.textContent = texto;
      contenedor.appendChild(div);
    };
    try {
      const res = await fetch(API_PRECIOS);
      const data = await res.json();
      if (data.status !== 'success') return mensaje(data.message || 'No pudimos cargar los paquetes.', true);
      metodos = data.metodos || [];
      if (!data.catalogo?.length) return mensaje('Por ahora no hay paquetes disponibles. Vuelve en un rato o escríbenos por WhatsApp.');
      dibujarPaquetes(data.catalogo);
    } catch (e) {
      mensaje('Fallo de conexión al cargar los paquetes. Revisa tu internet y recarga la página.', true);
    }
  }

  // "105 de oro" → número grande "105" + "de oro" pequeño; otros nombres, completos. Siempre como texto.
  const ICONO = '<svg class="paquete-icono" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 21 7v10l-9 5-9-5V7z" style="fill: var(--game-accent)"/><path d="M12 6.5 16.5 9v6L12 17.5 7.5 15V9z" style="fill: var(--bg-deep)"/><circle cx="12" cy="12" r="2.2" style="fill: var(--game-text)"/></svg>';
  function dibujarPaquetes(lista) {
    const contenedor = $('catalogContainer');
    contenedor.replaceChildren();
    const div = (clase, texto) => { const el = document.createElement('div'); el.className = clase; el.textContent = texto; return el; };
    lista.forEach((item, i) => {
      const card = document.createElement('div');
      card.className = 'product-card' + (lista.length % 2 && i === lista.length - 1 ? ' full-width' : '');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.insertAdjacentHTML('beforeend', ICONO);
      const partes = String(item.paquete).match(/^\s*([\d.,]+)\s+(.+)$/);
      if (partes) card.append(div('paquete-cantidad', partes[1]), div('paquete-nombre', partes[2]));
      else card.append(div('paquete-cantidad', item.paquete));
      const caja = div('price-box', '');
      caja.appendChild(div('price-text', textoBs(item.precio)));
      card.appendChild(caja);
      card.setAttribute('aria-label', `${item.paquete}, ${textoBs(item.precio)}`);
      const elegir = () => seleccionar(card, item);
      card.addEventListener('click', elegir);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elegir(); } });
      contenedor.appendChild(card);
    });
  }

  let pagoMostrado = false;
  function seleccionar(card, item) {
    document.querySelectorAll('.product-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    paqueteSeleccionado = item;
    $('montoPagar').textContent = textoBs(item.precio);
    $('stepTitlePaquete').classList.add('done');
    const pago = $('checkoutSection');
    pago.classList.add('active');
    if (!pagoMostrado) {
      pagoMostrado = true;
      setTimeout(() => pago.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
      // Precarga el lector de comprobantes mientras el cliente hace el Pago Móvil
      window.LectorReferencia?.cargarTesseract().catch(() => {});
    }
  }

  function copiar(valor, etiqueta, boton) {
    if (!valor) return;
    navigator.clipboard.writeText(String(valor)).then(() => {
      burbuja(`✅ ${etiqueta} copiado`);
      if (boton) { boton.textContent = '✓'; boton.classList.add('copied'); setTimeout(() => { boton.textContent = '📋'; boton.classList.remove('copied'); }, 2000); }
    }).catch(() => {});
  }

  // ---------- Comprobante y referencia ----------
  let urlVistaPrevia = null;
  async function alElegirComprobante() {
    const file = $('inputComprobante').files[0];
    const vista = $('uploadPreview'), zona = $('uploadDrop');
    if (urlVistaPrevia) { URL.revokeObjectURL(urlVistaPrevia); urlVistaPrevia = null; }
    const esImagen = file && file.type.startsWith('image/');
    if (esImagen) {
      urlVistaPrevia = URL.createObjectURL(file);
      $('uploadPreviewImg').src = urlVistaPrevia;
      $('uploadPreviewName').textContent = file.name;
    }
    vista.classList.toggle('active', !!esImagen);
    zona.style.display = esImagen ? 'none' : '';
    $('stepTitleComprobante').classList.toggle('done', !!esImagen);
    if (!esImagen || !window.LectorReferencia) return;

    // Lectura de la referencia en el teléfono del cliente (nunca toma la cédula ni el teléfono de la tienda)
    const caja = $('cajaIA'), cargando = $('cargandoIA'), resultado = $('resultadoIA');
    caja.style.display = 'block'; cargando.style.display = 'flex'; resultado.style.display = 'none';
    const referencia = await window.LectorReferencia.leer(file, [datosBanco.telefono, datosBanco.cedula]);
    if (!referencia) { caja.style.display = 'none'; return; }
    $('refIA').textContent = referencia;
    $('inputReferencia').value = referencia;
    $('stepTitleReferencia').classList.add('done');
    cargando.style.display = 'none'; resultado.style.display = 'block';
  }

  async function subirComprobante(file) {
    return new Promise((resolve) => {
      const limite = setTimeout(() => resolve('Sin comprobante (tiempo agotado)'), 8000);
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await fetch('/api/subir-imagen', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base64: reader.result, nombre: file.name, mimeType: file.type }),
          });
          const data = await res.json();
          resolve(data && data.url ? data.url : file.name);
        } catch (e) {
          resolve(file.name);
        } finally {
          clearTimeout(limite);
        }
      };
      reader.onerror = () => { clearTimeout(limite); resolve(file.name); };
      reader.readAsDataURL(file);
    });
  }

  // ---------- Ventana de datos de la cuenta ----------
  const metodoElegido = () => metodos.find((m) => m.id === document.querySelector('input[name="metodo"]:checked')?.value);

  function dibujarMetodos() {
    const caja = $('metodosLogin');
    caja.replaceChildren();
    metodos.forEach((m, i) => {
      const label = document.createElement('label');
      label.className = 'metodo-opcion';
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'metodo'; input.value = m.id;
      if (i === 0) input.checked = true;
      input.addEventListener('change', actualizarCamposMetodo);
      const span = document.createElement('span');
      span.textContent = m.nombre;
      label.append(input, span);
      caja.appendChild(label);
    });
    $('campoMetodo').style.display = metodos.length > 1 ? '' : 'none';
    actualizarCamposMetodo();
  }

  function actualizarCamposMetodo() {
    const m = metodoElegido();
    if (!m) return;
    const nombre = m.nombre.replace(/\s*\(.*\)$/, '');
    $('labelUsuario').textContent = m.id === 'google' ? 'Tu correo de Google (Gmail)'
      : m.telefono ? `Correo o teléfono de ${nombre}` : `Correo de ${nombre}`;
    $('inputUsuario').placeholder = m.telefono ? 'correo@ejemplo.com o número' : 'correo@ejemplo.com';
    $('inputUsuario').inputMode = m.telefono ? 'text' : 'email';
    $('campoClave').style.display = m.clave ? '' : 'none';
    $('labelClave').textContent = `Contraseña de ${nombre}`;
    // Supercell ID entra con un código que llega al correo: se pide por WhatsApp en el momento
    $('avisoSupercell').style.display = m.clave ? 'none' : 'block';
    $('avisoClave').style.display = m.clave ? 'block' : 'none';
  }

  function abrirDatosCuenta() {
    if (enviando) return;
    if (!paqueteSeleccionado) { burbuja('Primero elige un paquete.', true); $('catalogContainer').scrollIntoView({ behavior: 'smooth' }); return; }
    if (!$('inputComprobante').files[0]) { burbuja('⚠️ Sube el comprobante (capture) de tu pago.', true); $('uploadDrop').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (!/^\d{5}$/.test($('inputReferencia').value.trim())) { burbuja('⚠️ Escribe los últimos 5 dígitos de la referencia.', true); $('inputReferencia').focus(); return; }
    if (!metodos.length) { burbuja('No pudimos cargar las formas de inicio de sesión. Recarga la página.', true); return; }
    if (!document.querySelector('input[name="metodo"]')) dibujarMetodos();
    if (!$('inputWhatsapp').value) $('inputWhatsapp').value = leerWhatsapp();
    $('resumenPaquete').textContent = paqueteSeleccionado.paquete;
    $('resumenMonto').textContent = textoBs(paqueteSeleccionado.precio);
    $('resumenReferencia').textContent = $('inputReferencia').value.trim();
    $('btnEnviarPedido').disabled = false;
    $('modalCuenta').style.display = 'flex';
    setTimeout(() => $('inputUsuario').focus({ preventScroll: true }), 50);
  }

  function marcar(input, mensaje) {
    input.classList.add('con-error');
    input.focus();
    burbuja(mensaje, true);
    return false;
  }

  function datosValidos() {
    const m = metodoElegido();
    const usuario = $('inputUsuario'), clave = $('inputClave'), whatsapp = $('inputWhatsapp');
    [usuario, clave, whatsapp].forEach((el) => el.classList.remove('con-error'));
    const u = usuario.value.trim();
    const esTelefono = m.telefono && /^\+?\d{7,15}$/.test(u.replace(/[\s-]/g, ''));
    if (!CORREO.test(u) && !esTelefono) return marcar(usuario, m.telefono ? 'Escribe el correo o el teléfono de tu cuenta.' : 'Escribe un correo válido.');
    if (m.clave && !clave.value) return marcar(clave, 'Escribe la contraseña de tu cuenta.');
    if (clave.value.length > 100) return marcar(clave, 'La contraseña es demasiado larga.');
    if (!celular(whatsapp.value)) return marcar(whatsapp, 'Escribe tu WhatsApp (ej. 0414-1234567): por ahí te escribimos.');
    return true;
  }

  async function enviarPedido() {
    if (enviando || !datosValidos()) return;
    enviando = true;
    $('btnEnviarPedido').disabled = true;
    const m = metodoElegido();
    const telefono = celular($('inputWhatsapp').value);
    guardarWhatsapp(telefono);
    const cuerpo = {
      paquete: paqueteSeleccionado.paquete,
      referencia: $('inputReferencia').value.trim(),
      metodo: m.id,
      usuario: $('inputUsuario').value.trim(),
      clave: m.clave ? $('inputClave').value : '',
      telefono,
    };
    $('modalCuenta').style.display = 'none';
    $('pantallaProcesando').style.display = 'flex';
    $('textoProcesando').textContent = 'Subiendo tu comprobante...';

    try {
      cuerpo.url_capture = await subirComprobante($('inputComprobante').files[0]);
      $('textoProcesando').textContent = 'Verificando tu pago...';
      const res = await fetch(API_PEDIDO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
      let data = {};
      try { data = await res.json(); } catch (e) { /* respuesta vacía */ }
      $('pantallaProcesando').style.display = 'none';
      if (data.status === 'success') {
        // La contraseña ya está en camino: se borra de la página
        $('inputClave').value = '';
        mostrarExito(data, telefono);
      } else {
        mostrarError(data.message || 'No pudimos registrar tu pedido. Intenta de nuevo en un momento.');
      }
    } catch (e) {
      $('pantallaProcesando').style.display = 'none';
      mostrarError('Fallo de conexión. Revisa tu internet: si el pago ya se descontó, escríbenos por WhatsApp con tu referencia antes de volver a intentar.');
    } finally {
      enviando = false;
    }
  }

  function mostrarExito(data, telefono) {
    $('exitoPaquete').textContent = paqueteSeleccionado.paquete;
    $('exitoWhatsapp').textContent = `+58 ${telefono.slice(0, 3)}-${telefono.slice(3)}`;
    const incompleto = data.insuficiente === true;
    $('notaIncompleto').style.display = incompleto ? 'block' : 'none';
    if (incompleto) {
      $('faltaMonto').textContent = textoBs(data.falta);
      $('pagadoMonto').textContent = textoBs(data.pagado);
    }
    $('tituloExito').textContent = incompleto ? '¡PEDIDO RECIBIDO, PAGO INCOMPLETO!' : '¡PEDIDO RECIBIDO!';
    $('modalExito').style.display = 'flex';
  }

  function mostrarError(mensaje) {
    $('textoError').textContent = mensaje;
    $('modalError').style.display = 'flex';
  }

  // ---------- Ventanas abiertas: sin scroll de fondo ni botón flotante ----------
  const ventanas = document.querySelectorAll('.overlay-pantalla');
  const sincronizar = () => document.body.classList.toggle('modal-abierto',
    [...ventanas].some((v) => v.style.display && v.style.display !== 'none'));
  const observador = new MutationObserver(sincronizar);
  ventanas.forEach((v) => observador.observe(v, { attributes: true, attributeFilter: ['style'] }));

  // ---------- Eventos ----------
  $('btnCopiarDatos').addEventListener('click', () => {
    if (!datosBanco.banco) return;
    copiar(`Banco: ${datosBanco.banco}\nTeléfono: ${datosBanco.telefono}\nCédula: ${datosBanco.cedula}`, 'Datos');
  });
  $('btnCopiarMonto').addEventListener('click', (e) => paqueteSeleccionado && copiar(paqueteSeleccionado.precio, 'Monto', e.currentTarget));
  $('inputComprobante').addEventListener('change', alElegirComprobante);
  $('inputReferencia').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '');
    $('stepTitleReferencia').classList.toggle('done', e.target.value.length === 5);
  });
  $('btnComprar').addEventListener('click', abrirDatosCuenta);
  $('btnEnviarPedido').addEventListener('click', enviarPedido);
  $('btnVolverCuenta').addEventListener('click', () => { $('modalCuenta').style.display = 'none'; });
  $('btnCerrarError').addEventListener('click', () => { $('modalError').style.display = 'none'; });
  $('btnVerClave').addEventListener('click', () => {
    const campo = $('inputClave');
    const ver = campo.type === 'password';
    campo.type = ver ? 'text' : 'password';
    $('btnVerClave').textContent = ver ? 'Ocultar' : 'Ver';
    $('btnVerClave').setAttribute('aria-pressed', String(ver));
  });
  ['inputUsuario', 'inputClave', 'inputWhatsapp'].forEach((id) => $(id).addEventListener('input', (e) => e.target.classList.remove('con-error')));
  $('inputWhatsapp').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^\d\s+-]/g, ''); });
  // Si cierra la página con la ventana de datos abierta, la contraseña no queda en el formulario
  window.addEventListener('pagehide', () => { $('inputClave').value = ''; });

  cargarDatosBanco();
  cargarCatalogo();
})();
