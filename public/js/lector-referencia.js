// =========================================================================
// LECTOR DE REFERENCIAS DE PAGO MÓVIL (Tesseract.js, 100% en el navegador)
// Compartido por freefire.html, roblox.html y bloodstrike.html.
// Uso: const ref5 = await LectorReferencia.leer(file, [telefonoTienda, cedulaTienda]);
// =========================================================================
(function () {
  // Datos de la tienda que NUNCA pueden tomarse como referencia,
  // aunque Apps Script todavía no haya respondido con los datos bancarios.
  const NUMEROS_PROHIBIDOS = ['13476015', '04148653510'];

  // Palabras que identifican la línea donde va la referencia en los bancos venezolanos
  const ETIQUETA_REFERENCIA = /(referencia|ref\b|ref\.|operaci[oó]n|n[uú]mero de operaci|transacci[oó]n|comprobante|serial|secuencia|n[°ºo]\s*de\s*ref|nro\.?\s*(de\s*)?(ref|operaci|transac|comprob))/i;
  // Líneas cuyos números son datos personales, montos o fechas (no referencias)
  const ETIQUETA_DESCARTE = /(c[eé]dula|\bc\.?\s?i\b|identificaci|\brif\b|tel[eé]fono|\btelf|\btlf|celular|n[uú]mero de cuenta|\bcuenta\b|monto|\bbs\.?\b|bol[ií]vares|fecha|hora|beneficiario|destino|origen|emisor|receptor)/i;
  const SEPARADOR = '[ \\t.\\-]?'; // sin saltos de línea: no debe unir números de líneas distintas

  let promesaTesseract = null;
  function cargarTesseract() {
    if (typeof Tesseract !== 'undefined') return Promise.resolve();
    if (!promesaTesseract) {
      promesaTesseract = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        script.onload = resolve;
        script.onerror = () => { promesaTesseract = null; reject(); };
        document.head.appendChild(script);
      });
    }
    return promesaTesseract;
  }

  // Patrón que encuentra un número aunque el OCR lo parta con espacios, puntos o guiones
  function patronFlexible(digitos) {
    return digitos.split('').join(SEPARADOR);
  }

  // Normaliza teléfonos y cédulas a su parte significativa:
  // 04148653510 / +58 414-8653510 -> 4148653510 ; V-13.476.015 -> 13476015
  function nucleoNumero(valor) {
    let d = String(valor || '').replace(/\D/g, '');
    if (d.startsWith('58') && d.length === 12) d = d.slice(2);
    if (d.startsWith('0') && d.length === 11) d = d.slice(1);
    return d.length >= 6 ? d : null;
  }

  function construirExclusiones(datosExtra) {
    const nucleos = [...NUMEROS_PROHIBIDOS, ...(datosExtra || [])].map(nucleoNumero).filter(Boolean);
    return [...new Set(nucleos)];
  }

  // Borra del texto cualquier aparición (con prefijo 0, +58, V-, E-) de los números prohibidos
  function borrarNumerosProhibidos(texto, nucleos) {
    let limpio = texto;
    nucleos.forEach((nucleo) => {
      // (^|\D) en vez de lookbehind: compatible con Safari de iPhones antiguos
      const patron = new RegExp(`(^|\\D)(?:[VEJ]${SEPARADOR})?(?:\\+?58${SEPARADOR}|0${SEPARADOR})?${patronFlexible(nucleo)}`, 'gim');
      limpio = limpio.replace(patron, '$1 ');
    });
    return limpio;
  }

  function quitarFechasYHoras(linea) {
    return linea
      .replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, ' ')
      .replace(/\b\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}\b/g, ' ')
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm|a\.\s?m\.|p\.\s?m\.)?/gi, ' ')
      // Montos tipo 1.234,56 o 350,00
      .replace(/\b\d{1,3}(?:\.\d{3})*,\d{2}\b/g, ' ');
  }

  // Corrige confusiones típicas del OCR dentro de bloques numéricos (O->0, l/I->1)
  function corregirOCR(texto) {
    return texto.replace(/\b[\dOoIl|]{6,}\b/g, (bloque) =>
      /\d/.test(bloque) ? bloque.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1') : bloque
    );
  }

  // Un candidato es inválido si contiene un número prohibido o parece teléfono/cédula
  function esCandidatoValido(numero, nucleos) {
    if (numero.length < 6 || numero.length > 20) return false;
    if (nucleos.some((n) => numero.includes(n) || n.includes(numero))) return false;
    const ultimos5 = numero.slice(-5);
    if (nucleos.some((n) => n.slice(-5) === ultimos5)) return false;
    if (/^(0?58)?0?4(12|14|16|22|24|26)\d{7}$/.test(numero)) return false; // celular venezolano
    if (/^0?2\d{9}$/.test(numero)) return false;                          // teléfono fijo
    return true;
  }

  function cortarEnDescarte(texto) {
    const descarte = texto.match(ETIQUETA_DESCARTE);
    return descarte ? texto.slice(0, descarte.index) : texto;
  }

  function numerosEnLinea(linea) {
    return (quitarFechasYHoras(linea).match(/\d{6,20}/g) || []);
  }

  function extraerReferencia(textoOCR, datosExtra) {
    const nucleos = construirExclusiones(datosExtra);
    const lineas = borrarNumerosProhibidos(corregirOCR(textoOCR), nucleos)
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    // 1) Número en la misma línea de la etiqueta "Referencia/Operación" o en la siguiente
    for (let i = 0; i < lineas.length; i++) {
      const etiqueta = lineas[i].match(ETIQUETA_REFERENCIA);
      if (!etiqueta) continue;
      // Solo lo que va después de la etiqueta y antes de otro dato (fecha, cédula, monto...)
      const despuesEtiqueta = cortarEnDescarte(lineas[i].slice(etiqueta.index + etiqueta[0].length));
      const siguiente = ETIQUETA_DESCARTE.test(lineas[i + 1] || '') ? '' : (lineas[i + 1] || '');
      const candidatos = [...numerosEnLinea(despuesEtiqueta), ...numerosEnLinea(siguiente)]
        .filter((n) => esCandidatoValido(n, nucleos));
      if (candidatos.length) return candidatos[0].slice(-5);
    }

    // 2) Respaldo: el número largo más plausible fuera de líneas de cédula/teléfono/monto/fecha
    const candidatos = [];
    lineas.forEach((linea) => {
      if (ETIQUETA_DESCARTE.test(linea)) return;
      numerosEnLinea(linea).forEach((n) => { if (esCandidatoValido(n, nucleos)) candidatos.push(n); });
    });
    if (!candidatos.length) return null;
    // Las referencias bancarias suelen ser el número más largo; ante empate, el último
    const elegido = candidatos.reduce((mejor, n) => (n.length >= mejor.length ? n : mejor));
    return elegido.slice(-5);
  }

  // Las capturas del teléfono suelen ser modo oscuro y con texto pequeño:
  // se escalan, pasan a gris, se invierten si el fondo es oscuro y se sube el contraste.
  async function prepararImagen(file) {
    try {
      const bitmap = await createImageBitmap(file);
      const escala = Math.min(2.5, Math.max(1, 1800 / bitmap.width));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * escala);
      canvas.height = Math.round(bitmap.height * escala);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();

      const imagen = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = imagen.data;
      let suma = 0;
      for (let i = 0; i < px.length; i += 4) {
        const gris = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        px[i] = gris; suma += gris;
      }
      const invertir = suma / (px.length / 4) < 128;
      for (let i = 0; i < px.length; i += 4) {
        let g = invertir ? 255 - px[i] : px[i];
        g = Math.max(0, Math.min(255, (g - 128) * 1.6 + 128));
        px[i] = px[i + 1] = px[i + 2] = g;
      }
      ctx.putImageData(imagen, 0, 0);
      return canvas;
    } catch (e) {
      return file; // Formatos que el navegador no decodifica (p. ej. HEIC): se usa el original
    }
  }

  // Devuelve los últimos 5 dígitos de la referencia o null si no se pudo leer
  async function leer(file, datosExtra) {
    if (!file || !file.type.startsWith('image/')) return null;
    try {
      await cargarTesseract();
      const imagen = await prepararImagen(file);
      const resultado = await Tesseract.recognize(imagen, 'spa');
      return extraerReferencia(resultado.data.text || '', datosExtra);
    } catch (e) {
      return null;
    }
  }

  window.LectorReferencia = { leer, cargarTesseract, extraerReferencia };
})();
