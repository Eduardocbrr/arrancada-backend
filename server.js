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
const bcrypt = require('bcrypt');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Servidor está funcionando!');
});

mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

let pilotosPendentes = {};

const eventosPath = path.join(__dirname, 'eventos.json');
const usuariosPath = path.join(__dirname, 'usuarios.json');

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

function lerUsuarios() {
  try {
    if (!fs.existsSync(usuariosPath)) return [];
    const data = fs.readFileSync(usuariosPath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Erro ao ler usuários:', err);
    return [];
  }
}

function salvarUsuarios(usuarios) {
  fs.writeFileSync(usuariosPath, JSON.stringify(usuarios, null, 2));
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

app.post('/criar-conta', async (req, res) => {
  const { nome, email, senha } = req.body;
  const usuarios = lerUsuarios();
  const jaExiste = usuarios.find(u => u.email === email);
  if (jaExiste) return res.status(400).json({ erro: 'Email já cadastrado.' });

  const senhaCriptografada = await bcrypt.hash(senha, 10);
  usuarios.push({ nome, email, senha: senhaCriptografada });
  salvarUsuarios(usuarios);
  res.json({ sucesso: true });
});

app.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  if (email === "admin@arrancadaroraima.com.br" && senha === "admin123") {
    return res.json({ autorizado: true, tipo: "admin" });
  }

  const usuarios = lerUsuarios();
  const usuario = usuarios.find(u => u.email === email);

  if (!usuario) return res.json({ autorizado: false });

  const senhaOk = await bcrypt.compare(senha, usuario.senha);
  if (!senhaOk) return res.json({ autorizado: false });

  res.json({ autorizado: true, tipo: "piloto" });
});

app.get('/inscritos', (req, res) => {
  const caminho = './inscricoes_confirmadas.xlsx';
  if (!fs.existsSync(caminho)) return res.json([]);
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
    attachments: [{ filename: 'confirmacao_inscricao.pdf', path: caminhoPDF }]
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
