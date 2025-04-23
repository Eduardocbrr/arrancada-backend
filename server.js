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
const mongoose = require('mongoose');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Mercado Pago
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

// MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Conectado ao MongoDB com sucesso'))
  .catch(err => console.error('Erro ao conectar ao MongoDB:', err));

// Modelo para novos usuários
const UsuarioSchema = new mongoose.Schema({
  nome: String,
  sobrenome: String,
  apelido: String,
  equipe: String,
  email: String,
  senha: String
});
const Usuario = mongoose.model('Usuario', UsuarioSchema);

// Rota de cadastro
app.post('/cadastrar', async (req, res) => {
  const { nome, sobrenome, apelido, equipe, email, senha } = req.body;

  try {
    const existente = await Usuario.findOne({ email });
    if (existente) {
      return res.status(400).json({ mensagem: 'E-mail já cadastrado.' });
    }

    const novo = new Usuario({ nome, sobrenome, apelido, equipe, email, senha });
    await novo.save();
    res.status(201).json({ mensagem: 'Cadastro realizado com sucesso.' });
  } catch (erro) {
    console.error('Erro ao cadastrar:', erro);
    res.status(500).json({ mensagem: 'Erro no servidor.' });
  }
});

// Dados pendentes para PDF
let pilotosPendentes = {};

app.post('/criar-pagamento', async (req, res) => {
  const { preparador, equipe, moto, categoria, evento, email } = req.body;
  const idUnico = Date.now().toString();
  pilotosPendentes[idUnico] = { preparador, equipe, moto, categoria, evento, email };

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

app.post('/webhook', async (req, res) => {
  try {
    const idPagamento = req.body?.data?.id;
    if (!idPagamento) return res.sendStatus(400);

    const resultado = await mercadopago.payment.findById(idPagamento);
    const info = resultado.response;

    if (info.status === 'approved') {
      const ref = info.external_reference;
      const modoPagamento = info.payment_type_id;
      const dadosPiloto = pilotosPendentes[ref];

      if (!dadosPiloto) return res.sendStatus(404);

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

      const pdfPath = `./confirmacao_${ref}.pdf`;
      await gerarPdfConfirmacao(dadosPiloto, pdfPath);
      await enviarEmailComPDF(dadosPiloto, pdfPath);
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
  const admin = {
    email: "admin@arrancadaroraima.com.br",
    senha: "admin123"
  };

  if (email === admin.email && senha === admin.senha) {
    res.json({ autorizado: true });
  } else {
    res.json({ autorizado: false });
  }
});

// PDF + e-mail + Drive
async function gerarPdfConfirmacao(dados, caminhoPDF) {
  const { preparador, equipe, moto, categoria, evento } = dados;
  const qrTexto = `Piloto: ${preparador} | Equipe: ${equipe} | Moto: ${moto} | Categoria: ${categoria} | Evento: ${evento}`;
  const qrImageBuffer = await QRCode.toBuffer(qrTexto);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(caminhoPDF);
    doc.pipe(stream);
    doc.fontSize(20).text('Confirmação de Inscrição', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12);
    doc.text(`Preparador: ${preparador}`);
    doc.text(`Equipe: ${equipe}`);
    doc.text(`Moto: ${moto}`);
    doc.text(`Categoria: ${categoria}`);
    doc.text(`Evento: ${evento}`);
    doc.moveDown();
    doc.text('Apresente este QR Code na portaria do evento:', { align: 'left' });
    doc.image(qrImageBuffer, { fit: [150, 150], align: 'center' });
    doc.end();
    stream.on('finish', () => resolve());
    stream.on('error', (err) => reject(err));
  });
}

async function enviarEmailComPDF(dados, caminhoPDF) {
  const { preparador, moto, categoria, evento, email } = dados;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  const mailOptions = {
    from: `"Arrancada Roraima" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Confirmação de Inscrição - Arrancada Roraima',
    text: `Olá ${preparador}, sua inscrição foi confirmada para o evento "${evento}". Veja os detalhes no PDF em anexo.`,
    attachments: [
      {
        filename: `confirmacao_${moto}_${categoria}.pdf`,
        path: caminhoPDF
      }
    ]
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('E-mail enviado com sucesso para:', email);
  } catch (erro) {
    console.error('Erro ao enviar o e-mail:', erro.message);
  }
}

async function enviarParaGoogleDrive() {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
