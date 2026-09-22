const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!getApps().length) {
  try {
    initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY))
    });
  } catch (e) {
    console.error("Error al inicializar Firebase Admin:", e);
  }
}

const db = getFirestore();

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido' });
  }

  try {
    const { producto, jugadorId, orderId, referencia, urlImagen } = req.body;

    if (!referencia || !producto) {
      return res.status(200).json({ success: false, message: 'Faltan datos en la petición.' });
    }

    const snapshotPagos = await db.collection('Pagos').get();
    let pagoEncontradoDoc = null;

    snapshotPagos.forEach(docSnap => {
      let docId = docSnap.id.replace('ref_', '');
      if (docId.endsWith(referencia)) {
        pagoEncontradoDoc = { id: docSnap.id, ...docSnap.data() };
      }
    });

    if (!pagoEncontradoDoc) {
      return res.status(200).json({ success: false, message: 'No se encontró ningún pago con esa referencia.' });
    }

    if (pagoEncontradoDoc.estado === 'usado') {
      return res.status(200).json({ success: false, message: 'Esta referencia ya fue utilizada anteriormente.' });
    }

    const stockQuery = await db.collection('codigos_roblox')
      .where('producto_id', '==', String(producto))
      .where('estado', '==', 'disponible')
      .limit(1)
      .get();

    if (stockQuery.empty) {
      return res.status(200).json({ success: false, message: 'Lo sentimos, no hay stock disponible para este paquete de Robux.' });
    }

    const pinDoc = stockQuery.docs[0];
    const pinData = pinDoc.data();

    const batch = db.batch();

    batch.update(pinDoc.ref, {
      estado: 'vendido',
      orden_id: orderId,
      jugador_id: jugadorId,
      fecha_venta: new Date().toISOString()
    });

    batch.update(db.collection('Pagos').doc(pagoEncontradoDoc.id), {
      estado: 'usado',
      jugador_asignado: jugadorId,
      orden_asignada: orderId
    });

    const nuevoPedidoRef = db.collection('pedidos').doc();
    batch.set(nuevoPedidoRef, {
      orderId: orderId,
      categoria: 'Roblox',
      oferta: `${producto} Robux`,
      jugadorId: jugadorId,
      montoUsd: 0,
      estado: 'completed',
      creadoEn: new Date().toISOString()
    });

    await batch.commit();

    return res.status(200).json({
      success: true,
      codigo: pinData.codigo
    });

  } catch (error) {
    console.error("Error crítico en recargar-roblox:", error);
    return res.status(200).json({ success: false, message: 'Error interno en el servidor al procesar la recarga.' });
  }
};