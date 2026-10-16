import multer from 'multer';
import crypto from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// --- Stockage des fichiers : Cloudflare R2 (compatible S3) ---------------
// Avant, les fichiers étaient écrits sur le disque local (UPLOAD_DIR). En
// serverless (Vercel), le disque est éphémère : chaque fichier reçu est donc
// envoyé vers un bucket R2 à la place. Le bucket reste privé ; tout passage
// par l'API (upload, lecture, téléchargement, suppression) se fait via ces
// helpers.
const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

export async function uploadToR2(buffer, key, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return key;
}

// Renvoie un flux lisible (à .pipe() dans la réponse Express) + le type MIME.
export async function getR2ObjectStream(key) {
  const result = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  return result.Body; // stream Node.js
}

// URL signée temporaire (expire après `expiresIn` secondes) — utile pour un
// téléchargement direct sans faire transiter les octets par notre API.
export async function getR2SignedUrl(key, { expiresIn = 300, downloadFilename } = {}) {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ...(downloadFilename
      ? { ResponseContentDisposition: `attachment; filename="${downloadFilename}"` }
      : {}),
  });
  return getSignedUrl(s3, command, { expiresIn });
}

export async function deleteFromR2(key) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (err) {
    console.error(`Échec de la suppression R2 (${key}) :`, err.message);
  }
}

// --- Multer : on garde les fichiers en mémoire (buffer), plus sur disque ---
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
]);

const storage = multer.memoryStorage();

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

// Construit une clé R2 unique pour un fichier de devis, comme avant avec les
// noms de fichiers aléatoires sur disque (même logique, juste le nom de la clé).
export function devisFileKey(originalname) {
  const ext = originalname.includes('.') ? `.${originalname.split('.').pop().slice(0, 10)}` : '';
  return `devis/${crypto.randomUUID()}${ext}`;
}

// --- Photos du site (gérées depuis l'admin, affichées publiquement) ---
// Uniquement des images (pas de PDF) : ces fichiers sont affichés directement
// sur le site avec une balise <img>. Exception : la photo du hero accepte
// aussi une courte vidéo (fond animé), affichée avec une balise <video>.
const SITE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SITE_VIDEO_MIME = new Set(['video/mp4', 'video/webm']);
const VIDEO_ALLOWED_SLOTS = new Set(['accueil-hero']);

function siteImageFilter(req, file, cb) {
  if (SITE_IMAGE_MIME.has(file.mimetype)) return cb(null, true);
  if (SITE_VIDEO_MIME.has(file.mimetype) && VIDEO_ALLOWED_SLOTS.has(req.params.slot)) {
    return cb(null, true);
  }
  return cb(new Error(`Type de fichier non autorisé : ${file.mimetype}`));
}

export const siteImageUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: siteImageFilter,
  // Une vidéo pèse plus lourd qu'une photo : la limite est fixée pour le cas
  // le plus lourd (vidéo du hero). Sans effet sur les photos, plus légères.
  limits: { fileSize: 30 * 1024 * 1024, files: 1 },
}).single('image');

export function siteImageKey(slot, originalname) {
  const ext = originalname.includes('.') ? `.${originalname.split('.').pop().slice(0, 10)}` : '';
  return `site/${slot}-${crypto.randomUUID()}${ext}`;
}
