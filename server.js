const express = require('express');
const cors = require('cors');
const mercadopago = require('mercadopago');
const dotenv = require('dotenv');
const fs = require('fs');
const xlsx = require('xlsx');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const path = require('path');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

let pilotosPendentes = {};

// Rotas de gerenciamento de eventos
const eventosPath = path.join(__dirname, 'eventos.json');

function lerEventos() {
  try {
    if (!fs.existsSync(eventosPath)) return [];
    const data = fs.readFileSync(eventosPath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Erro ao ler eventos:', err);
    return [];
  }
}

function salvarEventos(eventos) {
  fs.writeFileSync(eventosPath, JSON.stringify(eventos, null, 2));
}

app.get('/api/eventos', (req, res) => {
  res.json(lerEventos());
});

app.post('/api/eventos', (req, res) => {
  const eventos = lerEventos();
  const novo = { id: Date.now().toString(), ...req.body };
  eventos.push(novo);
  salvarEventos(eventos);
  res.json(novo);
});

app.put('/api/eventos/:id', (req, res) => {
  let eventos = lerEventos();
  const { id } = req.params;
  eventos = eventos.map(ev => ev.id === id ? { ...ev, ...req.body } : ev);
  salvarEventos(eventos);
  res.json({ sucesso: true });
});

app.delete('/api/eventos/:id', (req, res) => {
  let eventos = lerEventos();
  const { id } = req.params;
  eventos = eventos.filter(ev => ev.id !== id);
  salvarEventos(eventos);
  res.json({ sucesso: true });
});

app.post('/criar-pagamento', async (req, res) => {
  const { preparador, equipe, piloto, email, evento, motos } = req.body;

  const quantidadeMotos = motos.length;
  const valorUnitario = 50.00;
  const valorTotal = quantidadeMotos * valorUnitario;

  const idUnico = Date.now().toString();
  pilotosPendentes[idUnico] = { preparador, equipe, piloto, email, evento, motos };

  const pagamento = {
    items: [
      {
        title: `Inscrição - ${evento} - ${quantidadeMotos} moto(s)`,
        quantity: 1,
        unit_price: valorTotal,
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

app.post('/webhook', async (req, res) => {
  try {
    const idPagamento = req.body?.data?.id;
    if (!idPagamento) return res.sendStatus(400);

    const resultado = await mercadopago.payment.findById(idPagamento);
    const info = resultado.response;

    if (info.status === 'approved') {
      const ref = info.external_reference;
      const modoPagamento = info.payment_type_id;
      const dados = pilotosPendentes[ref];

      if (!dados) return res.sendStatus(404);

      const registros = dados.motos.map(moto => ({
        "Nome do Preparador": dados.preparador,
        "Equipe": dados.equipe,
        "Piloto": dados.piloto,
        "Moto": moto.modelo,
        "Número": moto.numero,
        "Cor": moto.cor,
        "Categoria": moto.categoria,
        "Evento": dados.evento,
        "Data de Inscrição": new Date().toLocaleString(),
        "Status de Pagamento": "Pago",
        "Modo de Pagamento": modoPagamento
      }));

      const caminho = './inscricoes_confirmadas.xlsx';
      let planilha = [];
      if (fs.existsSync(caminho)) {
        const wb = xlsx.readFile(caminho);
        const ws = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        planilha = [...ws, ...registros];
      } else {
        planilha = registros;
      }

      const wbNovo = xlsx.utils.book_new();
      const wsNovo = xlsx.utils.json_to_sheet(planilha);
      xlsx.utils.book_append_sheet(wbNovo, wsNovo, 'Inscricoes');
      xlsx.writeFile(wbNovo, caminho);

      const pdfPath = `./confirmacao_${ref}.pdf`;
      await gerarPdfConfirmacao(dados, pdfPath);
      await enviarEmailComPDF(dados, pdfPath);
      await enviarParaGoogleDrive();
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Erro ao processar webhook:", error.message);
    res.sendStatus(500);
  }
});

app.post('/login', (req, res) => {
  const { email, senha } = req.body;

  if (email === "admin@arrancadaroraima.com.br" && senha === "admin123") {
    return res.json({ autorizado: true, tipo: "admin" });
  }

  if (email && senha) {
    return res.json({ autorizado: true, tipo: "piloto" });
  }

  res.json({ autorizado: false });
});

app.get('/inscritos', (req, res) => {
  const caminho = './inscricoes_confirmadas.xlsx';

  if (!fs.existsSync(caminho)) {
    return res.json([]);
  }

  try {
    const wb = xlsx.readFile(caminho);
    const ws = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    res.json(ws);
  } catch (erro) {
    console.error('Erro ao ler inscritos:', erro.message);
    res.status(500).json({ erro: 'Erro ao ler arquivo de inscritos' });
  }
});

// ... funções gerarPdfConfirmacao, enviarEmailComPDF, enviarParaGoogleDrive permanecem iguais ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
