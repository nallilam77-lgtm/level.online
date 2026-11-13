// =========================================================================
// WHATSAPP DE LA CUENTA (desde 2026-11-13)
// Ventana que pide el WhatsApp al cliente con sesión iniciada, para avisarle si gana algo (minijuego,
// premios). Lo carga js/sesion.js solo cuando la cuenta todavía no tiene número (tabla "perfiles" de
// supabase/tienda.sql) y perfil.html para cambiarlo. Se guarda por la API REST de Supabase con el token
// del cliente: RLS solo le deja escribir su propia fila. Sin librería de Supabase.
// "Ahora no" lo deja de pedir hasta que el cliente vuelva a abrir el navegador.
// API: TelefonoCuenta.abrir({ actual }) -> Promise<string|null> (el número guardado o null)
// =========================================================================
(function () {
  if (window.TelefonoCuenta) return;
  const CELULAR = /^4(12|14|16|22|24|26)\d{7}$/;
  const CLAVE_WHATSAPP = 'levelup_whatsapp';        // el mismo que recuerda js/whatsapp-cliente.js
  const CLAVE_LISTO = 'levelup_telefono_cuenta';   // id de la cuenta que ya tiene número (localStorage)
  const CLAVE_DESPUES = 'levelup_telefono_despues'; // "Ahora no" (sessionStorage)

  function leer(almacen, clave) { try { return almacen.getItem(clave) || ''; } catch (e) { return ''; } }
  function escribir(almacen, clave, valor) { try { almacen.setItem(clave, valor); } catch (e) { /* sin almacenamiento */ } }

  // "0414-123.45.67", "+58 414 1234567", "4141234567" -> "4141234567"
  function digitos(texto) {
    let d = String(texto || '').replace(/\D/g, '');
    if (d.startsWith('58')) d = d.slice(2);
    if (d.startsWith('0')) d = d.slice(1);
    return d.slice(0, 10);
  }

  function cargarEstilos() {
    if (document.querySelector('link[data-telefono-cuenta]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/css/telefono-cuenta.css?v=1'; l.dataset.telefonoCuenta = '';
    document.head.appendChild(l);
  }

  async function guardar(numero) {
    const c = await Sesion.config();
    const token = await Sesion.token();
    const d = Sesion.datos();
    if (!c || !c.supabaseUrl || !token || !d || !d.id) throw new Error('sin sesión');
    const res = await fetch(`${c.supabaseUrl}/rest/v1/perfiles?on_conflict=usuario`, {
      method: 'POST',
      headers: {
        apikey: c.supabaseKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ usuario: d.id, telefono: '+58' + numero, actualizado: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    escribir(localStorage, CLAVE_LISTO, d.id);
    escribir(localStorage, CLAVE_WHATSAPP, numero);
  }

  function abrir(opciones) {
    opciones = opciones || {};
    cargarEstilos();
    const previo = document.getElementById('telefonoCuenta');
    if (previo) previo.remove();

    return new Promise((resolver) => {
      const fondo = document.createElement('div');
      fondo.className = 'tel-cuenta';
      fondo.id = 'telefonoCuenta';
      fondo.innerHTML = `
        <form class="tel-cuenta__caja" role="dialog" aria-modal="true" aria-labelledby="telCuentaTitulo" novalidate>
          <h2 id="telCuentaTitulo">Tu WhatsApp</h2>
          <p>Si ganas en el minijuego o en una promoción, <strong>te avisamos por aquí</strong> para entregarte el premio.</p>
          <label class="tel-cuenta__campo">
            <span class="tel-cuenta__prefijo">+58</span>
            <input type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="14" placeholder="414 1234567" aria-label="Número de WhatsApp" required>
          </label>
          <p class="tel-cuenta__mensaje" role="alert"></p>
          <button type="submit" class="tel-cuenta__guardar">Guardar</button>
          <button type="button" class="tel-cuenta__despues">Ahora no</button>
          <small>Solo lo usamos para avisarte de premios y de tus pedidos. Nunca lo compartimos.</small>
        </form>`;
      const form = fondo.querySelector('form');
      const campo = fondo.querySelector('input');
      const mensaje = fondo.querySelector('.tel-cuenta__mensaje');
      const boton = fondo.querySelector('.tel-cuenta__guardar');
      campo.value = digitos(opciones.actual || leer(localStorage, CLAVE_WHATSAPP));

      function cerrar(valor) {
        document.removeEventListener('keydown', alTeclado);
        fondo.remove();
        resolver(valor);
      }
      function alTeclado(e) { if (e.key === 'Escape') despues(); }
      function despues() { escribir(sessionStorage, CLAVE_DESPUES, '1'); cerrar(null); }

      campo.addEventListener('input', () => {
        mensaje.textContent = '';
        campo.parentElement.classList.toggle('tel-cuenta__campo--ok', CELULAR.test(digitos(campo.value)));
      });
      fondo.querySelector('.tel-cuenta__despues').addEventListener('click', despues);
      document.addEventListener('keydown', alTeclado);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const numero = digitos(campo.value);
        if (!CELULAR.test(numero)) {
          mensaje.textContent = 'Escribe un celular venezolano: 0412, 0414, 0416, 0422, 0424 o 0426 y 7 números más.';
          campo.focus();
          return;
        }
        boton.disabled = true;
        boton.textContent = 'Guardando…';
        try {
          await guardar(numero);
          window.dispatchEvent(new CustomEvent('telefono-cuenta', { detail: '+58' + numero })); // perfil.html lo pinta
          cerrar('+58' + numero);
        } catch (error) {
          mensaje.textContent = 'No pudimos guardarlo. Revisa tu conexión e intenta de nuevo.';
          boton.disabled = false;
          boton.textContent = 'Guardar';
        }
      });

      document.body.appendChild(fondo);
      campo.parentElement.classList.toggle('tel-cuenta__campo--ok', CELULAR.test(campo.value));
      setTimeout(() => campo.focus(), 50);
    });
  }

  window.TelefonoCuenta = { abrir };
})();
