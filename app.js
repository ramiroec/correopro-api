const express = require('express');
const bodyParser = require('body-parser');
const db = require('./conexionDB'); // ← usa Pool de PostgreSQL
const nodemailer = require('nodemailer');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;

const app = express();

// Middleware para log de accesos
app.use((req, res, next) => {
  const start = process.hrtime();
  res.on('finish', () => {
    const durationInMilliseconds = getDurationInMilliseconds(start);
    console.log(`${new Date().toISOString()} - ${req.method} ${req.originalUrl} ${res.statusCode} ${durationInMilliseconds.toLocaleString()} ms`);
  });
  next();
});

function getDurationInMilliseconds(start) {
  const NS_PER_SEC = 1e9;
  const NS_TO_MS = 1e6;
  const diff = process.hrtime(start);
  return (diff[0] * NS_PER_SEC + diff[1]) / NS_TO_MS;
}

const allowedOrigins = [
  'https://correodg.netlify.app',
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    // Permitir requests sin "origin" (ej: Postman, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS no permitido desde este origen: ' + origin), false);
  },
  credentials: true, // por si usás cookies/autenticación
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());

console.log('🚀 Servidor inicializando...');

// Configuración de Cloudinary
cloudinary.config({
  cloud_name: 'dehsi2ubm',
  api_key: '534226953618942',
  api_secret: 'yd1gRm1d4X2PbGxpfIS9wtUbI1s'
});

// Multer para recibir archivos en memoria
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Añadir token de acceso (se puede sobreescribir con la variable de entorno API_TOKEN)
const API_TOKEN = process.env.API_TOKEN || 'clave...teki_token_12345';

// Middleware para validar Bearer token en Authorization (permitir preflight OPTIONS)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token faltante' });
  }
  const token = auth.slice(7);
  if (token !== API_TOKEN) {
    return res.status(403).json({ error: 'Token inválido' });
  }
  next();
});

// Importar rutas - Ahora pasamos db y sin transporter fijo
const correosRoutes = require('./correos')(db);
const listasRoutes = require('./listas')(db);
const usuariosRoutes = require('./usuarios')(db);

app.use('/correos', correosRoutes);
app.use('/listas', listasRoutes);
app.use('/usuarios', usuariosRoutes);

// Función para crear transporter dinámico basado en usuario (usar configuración "service: 'gmail'")
const crearTransporterUsuario = (usuario) => {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: usuario.gmail_email,
      pass: usuario.gmail_password
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateLimit: 10,
    rateDelta: 1000
  });
};

// Hacer la función disponible globalmente
app.locals.crearTransporterUsuario = crearTransporterUsuario;

// Subir imagen a Cloudinary
app.post('/upload', upload.single('image'), async (req, res) => {
  console.log('🖼️ Intentando subir archivo a Cloudinary...');
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

  try {
    const isPdf = req.file.mimetype === 'application/pdf';
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'correo-app',
        resource_type: isPdf ? 'raw' : 'image'
      },
      (error, result) => {
        if (error) {
          console.error('❌ Error al subir a Cloudinary:', error);
          return res.status(500).json({ error: 'Error al subir archivo a Cloudinary' });
        }
        res.json({ location: result.secure_url });
      }
    );
    stream.end(req.file.buffer);
  } catch (err) {
    console.error('❌ Error general al subir a Cloudinary:', err);
    res.status(500).json({ error: 'Error al subir archivo a Cloudinary' });
  }
});

// Iniciar servidor
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});

module.exports = app;