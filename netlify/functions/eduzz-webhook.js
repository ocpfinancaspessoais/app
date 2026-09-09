const crypto = require('crypto');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

function assinaturaValida(corpoBruto, assinaturaRecebida) {
  const chave = process.env.EDUZZ_WEBHOOK_SECRET;
  if (!chave || !assinaturaRecebida) return false;
  const esperado = crypto.createHmac('sha256', chave).update(corpoBruto).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(assinaturaRecebida));
  } catch (e) {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Endpoint ativo, aguardando eventos da Eduzz.' };
  }

  const corpoBruto = event.body || '';
  const assinaturaRecebida = event.headers['x-signature'] || event.headers['X-Signature'];

  if (!assinaturaValida(corpoBruto, assinaturaRecebida)) {
    console.log('Assinatura não confirmada. Corpo recebido:', corpoBruto);
    return { statusCode: 200, body: 'Assinatura não confirmada — evento ignorado.' };
  }

  let payload;
  try {
    payload = JSON.parse(corpoBruto);
  } catch (e) {
    return { statusCode: 200, body: 'JSON inválido — nada gravado.' };
  }

  // Log temporário só pra descobrirmos o formato real do campo "data"
  console.log('Evento recebido:', payload.event);
  console.log('Dados:', JSON.stringify(payload.data));

  const dados = payload.data || {};
  const email = (dados.email || dados.cus_email || dados.customer_email || '').toString().toLowerCase().trim();
  const produtoId = String(dados.product_cod || dados.produto_cod || dados.productId || '');

  if (!email) {
    return { statusCode: 200, body: 'Evento sem e-mail identificável. Nada gravado.' };
  }

    const PRODUTOS = {
    '3038286': 365, // Mentoria Premium Rumo à Prosperidade (EM GRUPO)
    '3029745': 365, // Mentoria Premium Rumo à Prosperidade (INDIVIDUAL)
    // 'CODIGO_DO_CURSO_AQUI': 180, // Curso — adicionar quando o produto for criado na Eduzz
  };
  const dias = PRODUTOS[produtoId];

  if (!dias) {
    return { statusCode: 200, body: 'Produto não mapeado (ID: ' + produtoId + '). Nada gravado.' };
  }

  const expiraEm = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);

  await db.collection('assinantes_pro').doc(email).set({
    proAte: expiraEm.toISOString(),
    origem: 'eduzz',
    produtoId
  }, { merge: true });

  return { statusCode: 200, body: 'OK - PRO liberado até ' + expiraEm.toISOString() };
};
