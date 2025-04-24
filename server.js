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

async function gerarPdfConfirmacao(dados, caminhoPDF) {
  const qrTexto = `Piloto: ${dados.piloto} | Equipe: ${dados.equipe} | Motos: ${dados.motos.length} | Evento: ${dados.evento}`;
  const qrImageBuffer = await QRCode.toBuffer(qrTexto);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(caminhoPDF);
    doc.pipe(stream);
    doc.fontSize(20).text('Confirmação de Inscrição', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12);
    doc.text(`Preparador: ${dados.preparador}`);
    doc.text(`Equipe: ${dados.equipe}`);
    doc.text(`Piloto: ${dados.piloto}`);
    doc.text(`Email: ${dados.email}`);
    doc.text(`Evento: ${dados.evento}`);
    dados.motos.forEach((moto, i) => {
      doc.moveDown();
      doc.text(`Moto ${i + 1}`);
      doc.text(`  Modelo: ${moto.modelo}`);
      doc.text(`  Número: ${moto.numero}`);
      doc.text(`  Cor: ${moto.cor}`);
      doc.text(`  Categoria: ${moto.categoria}`);
    });
    doc.moveDown();
    doc.text('Apresente este QR Code na portaria do evento:');
    doc.image(qrImageBuffer, { fit: [150, 150], align: 'center' });
    doc.end();
    stream.on('finish', () => resolve());
    stream.on('error', (err) => reject(err));
  });
}

async function enviarEmailComPDF(dados, caminhoPDF) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  const mailOptions = {
    from: `Arrancada Roraima <${process.env.EMAIL_USER}>`,
    to: dados.email,
    subject: 'Confirmação de Inscrição - Arrancada Roraima',
    text: `Olá ${dados.preparador}, sua inscrição para o evento "${dados.evento}" foi confirmada. Detalhes em anexo.`,
    attachments: [
      {
        filename: `confirmacao_inscricao.pdf`,
        path: caminhoPDF
      }
    ]
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('E-mail enviado com sucesso para:', dados.email);
  } catch (erro) {
    console.error('Erro ao enviar e-mail:', erro.message);
  }
}

async function enviarParaGoogleDrive() {
  const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-drive-key.json'),
    scopes: SCOPES
  });
  const drive = google.drive({ version: 'v3', auth });

  const arquivo = {
    name: 'inscricoes_confirmadas.xlsx',
    parents: ['1gOfJfnxMw3BtrPngBXYZoagKunkAVxvJ']
  };

  const arquivoMetadata = {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: fs.createReadStream(path.join(__dirname, 'inscricoes_confirmadas.xlsx'))
  };

  try {
    const resposta = await drive.files.create({
      requestBody: arquivo,
      media: arquivoMetadata,
      fields: 'id'
    });
    console.log('Arquivo enviado ao Drive. ID:', resposta.data.id);
  } catch (erro) {
    console.error('Erro no envio ao Drive:', erro.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
