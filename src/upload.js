import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error(`Type de fichier non autorisé : ${file.mimetype}`));
  }
  cb(null, true);
}

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 Mo par fichier
    files: 12,
  },
});

export const devisFileFields = upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'designs', maxCount: 6 },
  { name: 'photos', maxCount: 6 },
]);

// --- Photos du site (gérées depuis l'admin, affichées publiquement) ---
// Uniquement des images (pas de PDF) : ces fichiers sont affichés directement
// sur le site avec une balise <img>. Exception : la photo du hero accepte
// aussi une courte vidéo (fond animé), affichée avec une balise <video>.
const SITE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SITE_VIDEO_MIME = new Set(['video/mp4', 'video/webm']);
const VIDEO_ALLOWED_SLOTS = new Set(['home-hero']);

const siteImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `site-${crypto.randomUUID()}${ext}`);
  },
});

function siteImageFilter(req, file, cb) {
  if (SITE_IMAGE_MIME.has(file.mimetype)) return cb(null, true);
  if (SITE_VIDEO_MIME.has(file.mimetype) && VIDEO_ALLOWED_SLOTS.has(req.params.slot)) {
    return cb(null, true);
  }
  return cb(new Error(`Type de fichier non autorisé : ${file.mimetype}`));
}

export const siteImageUpload = multer({
  storage: siteImageStorage,
  fileFilter: siteImageFilter,
  // Une vidéo pèse plus lourd qu'une photo : la limite est fixée pour le cas
  // le plus lourd (vidéo du hero). Sans effet sur les photos, plus légères.
  limits: { fileSize: 30 * 1024 * 1024, files: 1 },
}).single('image');
