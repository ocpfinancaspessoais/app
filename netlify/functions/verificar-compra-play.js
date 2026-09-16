// netlify/functions/verificar-compra-play.js
//
// Recebe do app (cliente autenticado com Firebase) o purchaseToken retornado
// pela Digital Goods API depois de uma compra bem-sucedida, valida esse token
// diretamente com a Google Play Developer API (Android Publisher) e, se a
// assinatura estiver ativa, grava/atualiza o documento em assinantes_pro/{email}
// no Firestore — no mesmo padrão do eduzz-webhook.js.

const { google } = require('googleapis');
const admin = require('firebase-admin');

// Inicializa o Firebase Admin apenas uma vez (reaproveitado entre invocações)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// Nome do pacote do app publicado no Play Console
const PACKAGE_NAME = 'br.com.ocodigodaprosperidade.app';

// Mapa dos IDs de produto de assinatura -> quantos dias de acesso PRO cada um libera
const PRODUTOS_ASSINATURA = {
  assinatura_pro_mensal: 31,
  assinatura_pro_anual: 366,
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido' };
  }

  try {
    const { email, purchaseToken, productId } = JSON.parse(event.body || '{}');

    if (!email || !purchaseToken || !productId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ erro: 'Faltam campos: email, purchaseToken ou productId' }),
      };
    }

    if (!PRODUTOS_ASSINATURA[productId]) {
      return {
        statusCode: 400,
        body: JSON.stringify({ erro: `productId desconhecido: ${productId}` }),
      };
    }

    // Autentica na Google Play Developer API usando a service account
    const serviceAccountPlay = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountPlay,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });

    const androidpublisher = google.androidpublisher({
      version: 'v3',
      auth,
    });

    // Consulta o status real da assinatura na Google
    const resposta = await androidpublisher.purchases.subscriptionsv2.get({
      packageName: PACKAGE_NAME,
      token: purchaseToken,
    });

    const dadosAssinatura = resposta.data;
    const estadoAssinatura = dadosAssinatura.subscriptionState;

    // Estados considerados "ativo" pela Google Play Developer API
    const estadosAtivos = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'];

    if (!estadosAtivos.includes(estadoAssinatura)) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          sucesso: false,
          motivo: `Assinatura não está ativa (estado: ${estadoAssinatura})`,
        }),
      };
    }

    // Calcula até quando vale o acesso PRO
    const dias = PRODUTOS_ASSINATURA[productId];
    const proAte = new Date();
    proAte.setDate(proAte.getDate() + dias);

    // Grava/atualiza o documento no Firestore, igual ao webhook da Eduzz
    await db.collection('assinantes_pro').doc(email).set(
      {
        proAte: admin.firestore.Timestamp.fromDate(proAte),
        origem: 'google_play',
        produtoId: productId,
        purchaseToken,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ sucesso: true, proAte: proAte.toISOString() }),
    };
  } catch (erro) {
    console.error('Erro ao verificar compra do Google Play:', erro);
    return {
      statusCode: 500,
      body: JSON.stringify({ erro: 'Erro interno ao verificar a compra' }),
    };
  }
};
