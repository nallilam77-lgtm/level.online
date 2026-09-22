import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, query, where, getDocs, updateDoc, doc, addDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Configuración de tu proyecto de Firebase
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyBIdEh_HzzB8dnzG8qkPQYOIo2kSb_F6xQ",
  authDomain: "levelupstore-87d4d.firebaseapp.com",
  projectId: "levelupstore-87d4d",
  storageBucket: "levelupstore-87d4d.firebasestorage.app",
  messagingSenderId: "948536026825",
  appId: "1:948536026825:web:80520e4be7514a134d8f18"
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApps()[0];
const db = getFirestore(app);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Método no permitido' });
  }

  const { producto, jugadorId, orderId } = req.body;

  if (!producto || !jugadorId || !orderId) {
    return res.status(400).json({ success: false, message: 'Faltan datos obligatorios (producto, jugadorId u orderId)' });
  }

  try {
    // 1. Buscar un código disponible en la colección 'codigos_roblox'
    const codesRef = collection(db, 'codigos_roblox');
    const q = query(
      codesRef, 
      where('producto_id', '==', String(producto)), 
      where('estado', '==', 'disponible')
    );
    
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return res.status(400).json({ 
        success: false, 
        message: 'Lo sentimos, no hay stock disponible en este momento para este paquete de Roblox.' 
      });
    }

    // Tomar el primer documento disponible
    const codeDocSnap = snapshot.docs[0];
    const codeData = codeDocSnap.data();
    const codigoPin = codeData.codigo;

    // 2. Actualizar el documento para marcarlo como "vendido" y guardar el usuario (jugadorId)
    const codeDocRef = doc(db, 'codigos_roblox', codeDocSnap.id);
    await updateDoc(codeDocRef, {
      estado: 'vendido',
      orden_id: orderId,
      jugador_id: jugadorId,
      fecha_venta: new Date().toISOString()
    });

    // 3. Registrar el pedido en la colección general para que aparezca en tu Monitor de Pedidos
    await addDoc(collection(db, 'pedidos'), {
      orderId: orderId,
      categoria: 'Roblox',
      oferta: `${producto} Robux`,
      jugadorId: jugadorId,
      montoUsd: 0,
      estado: 'completed',
      codigoEntregado: codigoPin,
      creadoEn: new Date().toISOString()
    });

    // 4. Retornar el éxito y el código al cliente
    return res.status(200).json({
      success: true,
      message: '¡Recarga de Roblox procesada con éxito!',
      codigo: codigoPin,
      producto: `${producto} Robux`,
      jugadorId: jugadorId
    });

-  } catch (error) {
    console.error('Error al procesar el pin de Roblox:', error);
    return res.status(500).json({ success: false, message: 'Error interno en el servidor: ' + error.message });
  }
}