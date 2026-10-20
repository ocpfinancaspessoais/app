// netlify/functions/verificar-compra-play.js
//
// 1) Compra nova: recebe email + purchaseToken + productId do app, valida com a
//    Google Play Developer API, confirma (acknowledge) a assinatura e grava
//    assinantes_pro/{email} com proAte = data de vencimento real informada pelo Google.
// 2) Renovação: se vier { email, renovar: true }, usa o purchaseToken já guardado
//    no Firestore, consulta a Google de novo e atualiza o proAte.

const { google } = require('googleapis');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const PACKAGE_NAME = 'br.com.ocodigodaprosperidade.app';

// Dias de acesso usados só como reserva, caso a Google não informe o vencimento
const PRODUTOS_ASSINATURA = {
  assinatura_pro_mensal: 31,
  assinatura_pro_anual: 366,
};

const resp = (statusCode, obj) => ({ statusCode, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Método não permitido' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const email = String(body.email || '').trim().toLowerCase();
    let purchaseToken = body.purchaseToken;
    let productId = body.productId;

    if (!email) return resp(400, { erro: 'Falta o campo: email' });

    const docRef = db.collection('assinantes_pro').doc(email);

    // Modo renovação: pega token e produto que já estão guardados
    if (body.renovar === true) {
      const snap = await docRef.get();
      const salvo = snap.exists ? snap.data() : null;
      if (!salvo || salvo.origem !== 'google_play' || !salvo.purchaseToken || !salvo.produtoId) {
        return resp(200, { sucesso: false, motivo: 'Sem assinatura do Google Play para renovar' });
      }
      purchaseToken = salvo.purchaseToken;
      productId = salvo.produtoId;
    }

    if (!purchaseToken || !productId) {
      return resp(400, { erro: 'Faltam campos: purchaseToken ou productId' });
    }
    if (!PRODUTOS_ASSINATURA[productId]) {
      return resp(400, { erro: `productId desconhecido: ${productId}` });
    }

    const serviceAccountPlay = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountPlay,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const androidpublisher = google.androidpublisher({ version: 'v3', auth });

    const resposta = await androidpublisher.purchases.subscriptionsv2.get({
      packageName: PACKAGE_NAME,
      token: purchaseToken,
    });
    const dados = resposta.data;
    const estado = dados.subscriptionState;

    // Vencimento real informado pela Google
    const item = (dados.lineItems || []).find((i) => i.productId === productId) || (dados.lineItems || [])[0];
    let proAte = item && item.expiryTime ? new Date(item.expiryTime) : null;
    const agora = new Date();

    // ATIVA e CARÊNCIA valem; CANCELADA (sem renovar) vale até o vencimento
    const ativo = estado === 'SUBSCRIPTION_STATE_ACTIVE';
    const carencia = estado === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';
    const canceladaAindaValida = estado === 'SUBSCRIPTION_STATE_CANCELED' && proAte && proAte > agora;

    if (!ativo && !carencia && !canceladaAindaValida) {
      return resp(200, { sucesso: false, motivo: `Assinatura não está ativa (estado: ${estado})` });
    }

    if (!proAte || isNaN(proAte.getTime())) {
      proAte = new Date();
      proAte.setDate(proAte.getDate() + PRODUTOS_ASSINATURA[productId]);
    }
    if (carencia && proAte <= agora) {
      proAte = new Date(agora.getTime() + 3 * 24 * 60 * 60 * 1000);
    }

    // Confirma (acknowledge) a compra: se não for confirmada em 3 dias, o Google reembolsa sozinho
    if (dados.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
      try {
        await androidpublisher.purchases.subscriptions.acknowledge({
          packageName: PACKAGE_NAME,
          subscriptionId: productId,
          token: purchaseToken,
          requestBody: {},
        });
      } catch (e) {
        console.error('Falha ao confirmar (acknowledge) a assinatura:', e && e.message);
      }
    }

    await docRef.set(
      {
        proAte: admin.firestore.Timestamp.fromDate(proAte),
        origem: 'google_play',
        produtoId: productId,
        purchaseToken,
        estadoGoogle: estado,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return resp(200, { sucesso: true, proAte: proAte.toISOString() });
  } catch (erro) {
    console.error('Erro ao verificar compra do Google Play:', erro);
    return resp(500, { erro: 'Erro interno ao verificar a compra' });
  }
};
