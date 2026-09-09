const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Endpoint ativo, aguardando eventos da Eduzz.' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'JSON inválido' };
  }

  // ATENÇÃO: estes nomes de campo são um chute inicial.
  // Vamos ajustar depois de ver o formato real que a Eduzz envia.
  const email = (payload.cus_email || payload.email || '').toLowerCase().trim();
  const produtoId = String(payload.product_cod || payload.trans_cod_produto || '');

    if (!email) {
    return { statusCode: 200, body: 'Evento recebido (sem e-mail — provavelmente teste de verificação). Nada foi gravado.' };
  }

  // Mapeamento: código do produto na Eduzz -> dias de acesso PRO
  const PRODUTOS = {
    'MENTORIA_ID_AQUI': 365,
    'CURSO_ID_AQUI': 180
  };
  const dias = PRODUTOS[produtoId];

  if (!dias) {
    return { statusCode: 200, body: 'Produto não mapeado, nada gravado. ID recebido: ' + produtoId };
  }

  const expiraEm = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);

  await db.collection('assinantes_pro').doc(email).set({
    proAte: expiraEm.toISOString(),
    origem: 'eduzz',
    produtoId
  }, { merge: true });

  return { statusCode: 200, body: 'OK - PRO liberado até ' + expiraEm.toISOString() };
};
