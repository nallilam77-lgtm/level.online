# Reglas de diseño del frontend (OBLIGATORIAS)

Aplican a todo `public/` (HTML con CSS en línea dentro de `<style>`). No hay Tailwind: las clases que se citan abajo son la referencia y se escriben como CSS plano.

---

## 1. Prohibido el estilo genérico de IA

No se acepta nada que parezca una plantilla por defecto:
- Nada de fondos blancos o grises claros, botones azules estándar (`#007bff`, `#3b82f6`), bordes grises de 1px sin intención ni tarjetas planas sin profundidad.
- Nada de degradados morado-azul genéricos, emojis como iconos principales ni textos de relleno ("Lorem ipsum", "Bienvenido a nuestra tienda").
- Nada de fuentes del sistema por defecto: usar `'Montserrat'` (ya cargada) en títulos y texto.
- Cada componente nuevo debe verse como parte de una tienda de gaming, no como un formulario de ejemplo.

## 2. Estética gaming oscura

Colores definidos **solo** como variables en `:root` (nunca valores sueltos repetidos):

```css
:root {
  --bg-base: #0f172a;          /* fondo principal (slate-900) */
  --bg-deep: #0b1120;          /* secciones más profundas */
  --surface: rgba(15, 23, 42, 0.6);  /* base de tarjetas/barras con glass */
  --accent-cyan: #22d3ee;      /* acento principal (cyan-400) */
  --accent-neon: #39ff14;      /* verde neón: CTA y estados de éxito */
  --text-main: #f1f5f9;
  --text-muted: #94a3b8;
  --border-glass: rgba(148, 163, 184, 0.15);
}
```

- Fondos: `--bg-base` o grises muy oscuros. Nunca claros.
- Acentos vibrantes (cian o verde neón) solo en lo que debe destacar: botones de acción, precios, estados activos y foco. Si todo brilla, nada destaca.
- Contraste de texto mínimo WCAG AA (4.5:1) sobre el fondo.

## 3. Glassmorphism en navegación y tarjetas de producto

Obligatorio en la barra de navegación (`nav`/header fijo) y en las tarjetas de paquetes/productos:

```css
.glass {
  background: var(--surface);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);   /* Safari de iOS: imprescindible */
  border: 1px solid var(--border-glass);
  border-radius: 16px;
}
```

- Blur entre 10px y 16px; no usar valores distintos en cada página.
- Siempre con `-webkit-backdrop-filter` (muchos clientes usan iPhone).
- Debe haber algo detrás que se difumine (fondo con degradado o brillo); glass sobre un color plano no aporta nada.

## 4. Sombras suaves para dar profundidad

Equivalentes en CSS de `shadow-lg` + `shadow-cyan-500/20`:

```css
--shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.4), 0 4px 6px -4px rgba(0, 0, 0, 0.4);
--shadow-glow: 0 10px 25px -5px rgba(6, 182, 212, 0.2);   /* cyan-500 al 20 % */

.card { box-shadow: var(--shadow-lg), var(--shadow-glow); }
.card:hover { box-shadow: var(--shadow-lg), 0 12px 30px -5px rgba(6, 182, 212, 0.35); }
```

- Sombras difusas y de baja opacidad: nada de sombras negras duras ni `box-shadow: 0 0 20px` con color al 100 %.
- El brillo de color aumenta en `:hover`/`:focus-visible`; las transiciones duran 200-300 ms.

## 5. Espaciado amplio

La interfaz nunca debe verse amontonada:

| Elemento | Mínimo |
|---|---|
| Padding interno de tarjetas | 24px (`1.5rem`) |
| `gap` entre tarjetas de la cuadrícula | 24px (`1.5rem`); en escritorio, 32px |
| Padding vertical entre secciones | 64px (`4rem`); en móvil, 48px |
| Padding horizontal de la página en móvil | 16px |
| Altura mínima de botones/zonas táctiles | 44px |

**Excepción única: cuadrícula de paquetes de las tiendas en móvil (≤ 480px).** Son dos columnas dentro del panel; con 24px por todos lados cada tarjeta quedaría en ~80px útiles y un precio como `12.345,67 Bs` no cabe. Ahí se usa `gap: 16px` y `padding: 20px 8px`, con el precio en una línea (`white-space: nowrap`; 13px por debajo de 380px). Desde 481px vuelven los 24px. No extender esta excepción a otros componentes.

- Usar `display: grid`/`flex` con `gap`, no márgenes sueltos entre hermanos.
- Comprobar siempre a 360px de ancho (móvil Android básico, muy común en Venezuela): sin scroll horizontal.

---

## Antes de entregar un cambio de estilos

- [ ] Ningún color fuera de las variables de `:root`.
- [ ] Barra de navegación y tarjetas con glass + `-webkit-backdrop-filter`.
- [ ] Sombras `--shadow-lg` + `--shadow-glow`, más intensas en hover.
- [ ] Espaciados de la tabla del punto 5.
- [ ] Revisado a 360px y en escritorio.
