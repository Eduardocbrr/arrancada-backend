const { google } = require('googleapis');
const path = require ('path');
const express = require('express');
const cors = require('cors');
const mercadopago = require('mercadopago');
const dotenv = require('dotenv');
const fs = require('fs');
const xlsx = require('xlsx');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Configurar o Mercado Pago
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

// Armazenamento temporário de inscrições antes do pagamento
let pilotosPendentes = {};

// ROTA PARA CRIAR PAGAMENTO
app.post('/criar-pagamento', async (req, res) => {
  const { preparador, equipe, moto, categoria, evento } = req.body;

  const idUnico = Date.now().toString();
  pilotosPendentes[idUnico] = { preparador, equipe, moto, categoria, evento };

  const pagamento = {
    items: [
      {
        title: `Inscrição - ${moto} - ${categoria}`,
        quantity: 1,
        unit_price: 50.00,
        currency_id: 'BRL'
      }
    ],
    back_urls: {
      success: "https://arrancadaroraima.com.br/sucesso",
      failure: "https://arrancadaroraima.com.br/falha",
      pending: "https://arrancadaroraima.com.br/pendente"
    },
    auto_return: "approved",
    external_reference: idUnico,
    notification_url: "https://arrancada-backend.onrender.com/webhook"
  };

  try {
    const pref = await mercadopago.preferences.create(pagamento);
    res.json({ link: pref.body.init_point });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ROTA DE WEBHOOK PARA PROCESSAR PAGAMENTOS
app.post('/webhook', async (req, res) => {
  try {
    const idPagamento = req.body?.data?.id;

    if (!idPagamento) {
      console.error("ID de pagamento não recebido.");
      return res.sendStatus(400);
    }

    const resultado = await mercadopago.payment.findById(idPagamento);
    const info = resultado.response;

    if (info.status === 'approved') {
      const ref = info.external_reference;
      const modoPagamento = info.payment_type_id;
      const dadosPiloto = pilotosPendentes[ref];

      if (!dadosPiloto) {
        console.error("Dados do piloto não encontrados para o pagamento:", ref);
        return res.sendStatus(404);
      }

      const novaInscricao = {
        "Nome do Preparador": dadosPiloto.preparador,
        "Equipe": dadosPiloto.equipe,
        "Moto": dadosPiloto.moto,
        "Categoria": dadosPiloto.categoria,
        "Evento": dadosPiloto.evento,
        "Data de Inscrição": new Date().toLocaleString(),
        "Status de Pagamento": "Pago",
        "Modo de Pagamento": modoPagamento
      };

      const caminho = './inscricoes_confirmadas.xlsx';
      let planilha = [];

      if (fs.existsSync(caminho)) {
        const wb = xlsx.readFile(caminho);
        const ws = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        planilha = [...ws, novaInscricao];
      } else {
        planilha = [novaInscricao];
      }

      const wbNovo = xlsx.utils.book_new();
      const wsNovo = xlsx.utils.json_to_sheet(planilha);
      xlsx.utils.book_append_sheet(wbNovo, wsNovo, 'Inscricoes');
      xlsx.writeFile(wbNovo, caminho);

      console.log("Inscrição salva com sucesso na planilha.");
      await enviarParaGoogleDrive();
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Erro ao processar webhook:", error.message);
    res.sendStatus(500);
  }
});

// Iniciar o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});async function enviarParaGoogleDrive() {
  const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-drive-key.json'),
    scopes: SCOPES,
  });

  const drive = google.drive({ version: 'v3', auth });

  const arquivo = {
    name: 'inscricoes_confirmadas.xlsx',
    parents: ['1gOfJfnxMw3BtrPngBXYZoagKunkAVxvJ'],
  };

  const arquivoMetadata = {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: fs.createReadStream(path.join(__dirname, 'inscricoes_confirmadas.xlsx')),
  };

  try {
    const resposta = await drive.files.create({
      requestBody: arquivo,
      media: arquivoMetadata,
      fields: 'id',
    });

    console.log('Arquivo enviado para o Drive com sucesso. ID:', resposta.data.id);
  } catch (erro) {
    console.error('Erro ao enviar para o Google Drive:', erro.message);
  }
}