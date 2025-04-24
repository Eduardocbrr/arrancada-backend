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
const crypto = require('crypto');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

mercadopago.configure({ access_token: process.env.MP_ACCESS_TOKEN });

let pilotosPendentes = {};
const eventosPath = path.join(__dirname, 'eventos.json');
const usuariosPath = path.join(__dirname, 'usuarios.json');

function lerEventos() {
  if (!fs.existsSync(eventosPath)) return [];
  return JSON.parse(fs.readFileSync(eventosPath, 'utf-8'));
}

function salvarEventos(eventos) {
  fs.writeFileSync(eventosPath, JSON.stringify(eventos, null, 2));
}

function lerUsuarios() {
  if (!fs.existsSync(usuariosPath)) return [];
  return JSON.parse(fs.readFileSync(usuariosPath, 'utf-8'));
}

function salvarUsuarios(usuarios) {
  fs.writeFileSync(usuariosPath, JSON.stringify(usuarios, null, 2));
}

app.get('/', (req, res) => res.send('Servidor está funcionando!'));

app.get('/api/eventos', (req, res) => res.json(lerEventos()));

app.post('/api/eventos', (req, res) => {
  const eventos = lerEventos();
  const novo = { id: Date.now().toString(), ...req.body };
  eventos.push(novo);
  salvarEventos(eventos);
  res.json(novo);
});

app.put('/api/eventos/:id', (req, res) => {
  let eventos = lerEventos();
  eventos = eventos.map(ev => ev.id === req.params.id ? { ...ev, ...req.body } : ev);
  salvarEventos(eventos);
  res.json({ sucesso: true });
});

app.delete('/api/eventos/:id', (req, res) => {
  let eventos = lerEventos().filter(ev => ev.id !== req.params.id);
  salvarEventos(eventos);
  res.json({ sucesso: true });
});

app.post('/criar-conta', async (req, res) => {
  const { nome, email, senha } = req.body;
  const usuarios = lerUsuarios();
  if (usuarios.find(u => u.email === email)) return res.status(400).json({ erro: 'Email já cadastrado.' });

  const senhaCriptografada = await bcrypt.hash(senha, 10);
  const tokenVerificacao = crypto.randomBytes(20).toString('hex');

  const novoUsuario = {
    nome,
    email,
    senha: senhaCriptografada,
    verificado: false,
    tokenVerificacao
  };

  usuarios.push(novoUsuario);
  salvarUsuarios(usuarios);

  const link = `https://arrancadaroraima.com.br/verificar-email.html?token=${tokenVerificacao}`;
  await enviarEmailVerificacao(email, link);
  res.json({ sucesso: true, mensagem: 'Verifique seu e-mail para ativar a conta.' });
});

app.get('/verificar-email', (req, res) => {
  const { token } = req.query;
  const usuarios = lerUsuarios();
  const index = usuarios.findIndex(u => u.tokenVerificacao === token);

  if (index === -1) return res.status(400).send('Token inválido ou expirado');

  usuarios[index].verificado = true;
  delete usuarios[index].tokenVerificacao;
  salvarUsuarios(usuarios);

  res.redirect('/verificado.html');
});

app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (email === "admin@arrancadaroraima.com.br" && senha === "admin123") return res.json({ autorizado: true, tipo: "admin" });

  const usuarios = lerUsuarios();
  const usuario = usuarios.find(u => u.email === email);

  if (!usuario || !usuario.verificado) return res.json({ autorizado: false });

  const senhaOk = await bcrypt.compare(senha, usuario.senha);
  if (!senhaOk) return res.json({ autorizado: false });

  res.json({ autorizado: true, tipo: "piloto", email: usuario.email });
});

async function enviarEmailVerificacao(destino, link) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });

  await transporter.sendMail({
    from: `Arrancada Roraima <${process.env.EMAIL_USER}>`,
    to: destino,
    subject: 'Confirme seu cadastro',
    html: `<p>Olá, clique no link abaixo para confirmar seu cadastro:</p><p><a href="${link}">${link}</a></p>`
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
