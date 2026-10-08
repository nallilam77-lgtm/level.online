// Conexión a Firestore (firebase-admin) compartida por los endpoints.
// Usa la variable FIREBASE_SERVICE_ACCOUNT; sin ella obtenerDb() devuelve null.
// (Los archivos con "_" dentro de /api no se publican como endpoints en Vercel.)

let promesaDb = null;
let avisoSinCredenciales = false;

// firebase-admin pesa: se importa solo si hay credenciales y solo la primera vez que se usa,
// para no alargar el arranque en frío de las funciones.
export function obtenerDb() {
  const cuenta = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!cuenta) {
    if (!avisoSinCredenciales) {
      console.error("⚠️ firestore: falta FIREBASE_SERVICE_ACCOUNT en Vercel.");
      avisoSinCredenciales = true;
    }
    return Promise.resolve(null);
  }
  if (!promesaDb) {
    promesaDb = (async () => {
      try {
        const [{ initializeApp, cert, getApps }, { getFirestore }] = await Promise.all([
          import('firebase-admin/app'),
          import('firebase-admin/firestore'),
        ]);
        const app = getApps().length ? getApps()[0] : initializeApp({ credential: cert(JSON.parse(cuenta)) });
        return getFirestore(app);
      } catch (error) {
        console.error("❌ firestore: FIREBASE_SERVICE_ACCOUNT inválida o firebase-admin no disponible:", error.message);
        return null;
      }
    })();
  }
  return promesaDb;
}

export function conTiempoLimite(promesa, ms) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(`Firestore tardó más de ${ms} ms`)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}
