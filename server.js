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

mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

let pilotosPendentes = {};

// Rota para criar pagamento
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
    external_reference: idUnico
  };

  try {
    const pref = await mercadopago.preferences.create(pagamento);
    res.json({ link: pref.body.init_point });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Webhook oficial do Mercado Pago
app.post('/webhook', async (req, res) => {
  try {
    const pagamento = req.body;

    if (pagamento?.data?.id) {
      const pagamentoDetalhes = await mercadopago.payment.findById(pagamento.data.id);
      const info = pagamentoDetalhes.response;

      if (info.status === 'approved') {
        const ref = info.external_reference;
        const modoPagamento = info.payment_type_id;
        const dadosPiloto = pilotosPendentes[ref];

        if (dadosPiloto) {
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
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Erro ao processar webhook:", error.message);
    res.sendStatus(500);
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});