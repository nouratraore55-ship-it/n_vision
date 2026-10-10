import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { prisma } from './src/prismaClient.js';
import { verifyPassword, signToken, requireAuth } from './src/auth.js';
import {
  devisFileFields,
  siteImageUpload,
  devisFileKey,
  siteImageKey,
  uploadToR2,
  getR2ObjectStream,
  getR2SignedUrl,
  deleteFromR2,
} from './src/upload.js';
import { notifyNewDevis } from './src/mailer.js';

const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const app = express();

// Derrière un proxy (Vercel, Render, Railway, ...) il faut le dire à Express,
// sinon express-rate-limit lit mal l'IP du client (ou plante carrément).
app.set('trust proxy', 1);

// Par défaut, Helmet empêche ce serveur d'être appelé depuis une autre origine
// (même en local) — on l'autorise ici puisque le site (une autre origine) doit
// pouvoir l'appeler.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '2mb' }));

// --- anti-abus : limite le nombre de requêtes sur les points sensibles ---
const publicFormLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de demandes envoyées. Réessayez plus tard.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion. Réessayez plus tard.' },
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'n-vision-backend' });
});

// Route de diagnostic TEMPORAIRE (a retirer une fois le probleme resolu) :
// ne revele jamais la valeur complete de DATABASE_URL, seulement sa forme.
app.get('/api/_debug-env', (req, res) => {
  const dbUrl = process.env.DATABASE_URL || '';
  res.json({
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    length: dbUrl.length,
    startsOk: /^postgres(ql)?:\/\//.test(dbUrl),
    first12: dbUrl.slice(0, 12),
    last6: dbUrl.slice(-6),
    hasNewlineOrSpace: /[\s]/.test(dbUrl),
  });
});

// `details` est stocké en texte JSON (même format qu'avant), on le reconvertit
// en objet avant de le renvoyer au site.
function serializeDevis(devis) {
  if (!devis) return devis;
  let details = {};
  try {
    details = JSON.parse(devis.details || '{}');
  } catch {
    details = {};
  }
  return { ...devis, details };
}

// ---------------------------------------------------------------------------
// AUTH — connexion admin (compte email + mot de passe)
// ---------------------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Identifiants incorrects.' });

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Identifiants incorrects.' });

  const token = signToken(user);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// DEMANDES DE DEVIS
// ---------------------------------------------------------------------------

const KNOWN_FIELDS = ['entreprise', 'contact', 'email', 'telephone'];

// Réception d'une nouvelle demande depuis le questionnaire public (avec fichiers)
app.post('/api/devis', publicFormLimiter, (req, res, next) => {
  devisFileFields(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const body = req.body || {};

  if (!body.contact || (!body.email && !body.telephone)) {
    return res.status(400).json({ error: 'Nom et un moyen de contact (téléphone ou email) sont requis.' });
  }

  const details = {};
  for (const [key, value] of Object.entries(body)) {
    if (!KNOWN_FIELDS.includes(key)) details[key] = value;
  }

  try {
    const devis = await prisma.devisRequest.create({
      data: {
        entreprise: body.entreprise || '',
        contact: body.contact || null,
        email: body.email || '',
        telephone: body.telephone || null,
        details: JSON.stringify(details),
      },
    });

    const files = req.files || {};
    const fileRows = [];
    for (const kind of ['logo', 'designs', 'photos']) {
      const list = files[kind] || [];
      for (const f of list) {
        // Les fichiers arrivent en mémoire (multer.memoryStorage) : on les
        // envoie vers R2 ici, puis on garde seulement la clé en base.
        const key = devisFileKey(f.originalname);
        await uploadToR2(f.buffer, key, f.mimetype);
        fileRows.push({
          devisRequestId: devis.id,
          kind: kind === 'logo' ? 'logo' : kind === 'designs' ? 'design' : 'photo',
          originalName: f.originalname,
          storedName: key,
          mimeType: f.mimetype,
          size: f.size,
        });
      }
    }
    if (fileRows.length) {
      await prisma.devisFile.createMany({ data: fileRows });
    }

    notifyNewDevis(devis); // ne bloque pas la réponse si l'email échoue

    res.status(201).json({ ok: true, id: devis.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Une erreur est survenue lors de l'enregistrement." });
  }
});

// Liste des demandes (admin uniquement)
app.get('/api/devis', requireAuth, async (req, res) => {
  try {
    const list = await prisma.devisRequest.findMany({
      orderBy: { receivedAt: 'desc' },
      include: { files: true },
    });
    res.json(list.map(serializeDevis));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Une erreur est survenue.' });
  }
});

// Détail d'une demande (admin uniquement)
app.get('/api/devis/:id', requireAuth, async (req, res) => {
  try {
    const devis = await prisma.devisRequest.findUnique({
      where: { id: req.params.id },
      include: { files: true },
    });
    if (!devis) return res.status(404).json({ error: 'Introuvable' });
    res.json(serializeDevis(devis));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Une erreur est survenue.' });
  }
});

// Mise à jour du statut (admin uniquement)
app.patch('/api/devis/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['nouveau', 'en_cours', 'devis_envoye'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status doit être l'un de: ${allowed.join(', ')}` });
  }
  try {
    const devis = await prisma.devisRequest.update({
      where: { id: req.params.id },
      data: { status },
    });
    res.json(serializeDevis(devis));
  } catch {
    res.status(404).json({ error: 'Introuvable' });
  }
});

// Téléchargement d'un fichier joint (admin uniquement — jamais public).
// Le fichier vit sur R2 : on redirige vers une URL signée, valable 5 minutes,
// qui force le téléchargement sous le nom d'origine.
app.get('/api/devis/:id/files/:fileId', requireAuth, async (req, res) => {
  try {
    const file = await prisma.devisFile.findUnique({ where: { id: req.params.fileId } });
    if (!file || file.devisRequestId !== req.params.id) {
      return res.status(404).json({ error: 'Fichier introuvable' });
    }
    const url = await getR2SignedUrl(file.storedName, {
      expiresIn: 300,
      downloadFilename: file.originalName,
    });
    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Une erreur est survenue.' });
  }
});

// ---------------------------------------------------------------------------
// PHOTOS DU SITE — gérées depuis l'admin, affichées publiquement sur le site
// ---------------------------------------------------------------------------

// Emplacements autorisés — doit rester cohérent avec la liste utilisée dans
// l'admin (site/src/pages/Admin.jsx, SITE_IMAGE_GROUPS).
const SITE_IMAGE_SLOTS = new Set([
  'home-hero',
  'home-service-cartons',
  'home-service-sacs-kraft',
  'home-service-sacs-plastique',
  'home-service-papier-de-soie',
  'home-service-cartes-remerciement',
  'home-service-autocollants',
  'home-category-cartons',
  'home-category-sacs-kraft',
  'home-category-sacs-plastique',
  'home-category-papier-de-soie',
  'home-category-cartes-remerciement',
  'home-category-autocollants',
  'service-cartons-boites',
  'service-sacs-kraft',
  'service-sacs-plastique',
  'service-papier-de-soie',
  'service-cartes-remerciement',
  'service-autocollants',
  'realisation-1',
  'realisation-2',
  'realisation-3',
  'realisation-4',
  'realisation-5',
  'realisation-6',
]);

// Envoi/remplacement d'une photo (admin uniquement)
app.post('/api/site-images/:slot', requireAuth, (req, res, next) => {
  // On vérifie l'emplacement AVANT de laisser multer traiter le fichier, pour
  // ne jamais envoyer un fichier orphelin vers R2 pour un slot inconnu.
  if (!SITE_IMAGE_SLOTS.has(req.params.slot)) {
    return res.status(400).json({ error: 'Emplacement photo inconnu.' });
  }
  next();
}, (req, res, next) => {
  siteImageUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const { slot } = req.params;
  if (!req.file) {
    return res.status(400).json({ error: 'Aucune image envoyée.' });
  }

  try {
    const existing = await prisma.siteImage.findUnique({ where: { slot } });

    const key = siteImageKey(slot, req.file.originalname);
    await uploadToR2(req.file.buffer, key, req.file.mimetype);

    const image = await prisma.siteImage.upsert({
      where: { slot },
      update: { filename: key, mimeType: req.file.mimetype },
      create: { slot, filename: key, mimeType: req.file.mimetype },
    });

    // Supprime l'ancienne image de R2 (remplacée par la nouvelle)
    if (existing && existing.filename !== key) {
      deleteFromR2(existing.filename);
    }

    res.status(201).json({
      ok: true,
      slot: image.slot,
      mimeType: image.mimeType,
      updatedAt: image.updatedAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Une erreur est survenue lors de l'enregistrement de la photo." });
  }
});

// Type de fichier d'un emplacement (public, pas de contenu — juste de quoi savoir
// si on doit afficher une balise <img> ou <video> côté site).
app.get('/api/site-images/:slot/meta', async (req, res) => {
  const image = await prisma.siteImage.findUnique({ where: { slot: req.params.slot } });
  if (!image) return res.json({ exists: false, mimeType: null });
  res.json({ exists: true, mimeType: image.mimeType });
});

// Affichage public d'une photo du site (pas d'authentification : utilisée dans une balise <img>)
app.get('/api/site-images/:slot/file', async (req, res) => {
  try {
    const image = await prisma.siteImage.findUnique({ where: { slot: req.params.slot } });
    if (!image) return res.status(404).end();

    const stream = await getR2ObjectStream(image.filename);
    res.set('Cache-Control', 'no-cache');
    res.type(image.mimeType);
    stream.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(404).end();
  }
});

// ---------------------------------------------------------------------------
// RÉALISATIONS — titre + description de chaque projet (page "Réalisations")
// La photo de chaque projet reste gérée via SiteImage, avec le même "slot".
// ---------------------------------------------------------------------------

const REALISATION_SLOTS = [
  'realisation-1',
  'realisation-2',
  'realisation-3',
  'realisation-4',
  'realisation-5',
  'realisation-6',
];

// Contenu par défaut tant que l'admin n'a pas encore renseigné le projet.
function defaultRealisation(slot) {
  const n = slot.split('-')[1];
  return {
    slot,
    title: `Projet ${n}`,
    description: 'Description courte du projet, du besoin client et de la solution apportée.',
  };
}

// Liste complète des réalisations (public — utilisée sur la page Réalisations du site)
app.get('/api/realisations', async (req, res) => {
  try {
    const rows = await prisma.realisation.findMany();
    const bySlot = Object.fromEntries(rows.map((r) => [r.slot, r]));
    const list = REALISATION_SLOTS.map((slot) => {
      const saved = bySlot[slot];
      return saved
        ? { slot: saved.slot, title: saved.title, description: saved.description }
        : defaultRealisation(slot);
    });
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Une erreur est survenue.' });
  }
});

// Mise à jour du titre / de la description d'un projet (admin uniquement)
app.put('/api/realisations/:slot', requireAuth, async (req, res) => {
  const { slot } = req.params;
  if (!REALISATION_SLOTS.includes(slot)) {
    return res.status(400).json({ error: 'Emplacement de réalisation inconnu.' });
  }
  const { title, description } = req.body || {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Le titre est requis.' });
  }
  try {
    const saved = await prisma.realisation.upsert({
      where: { slot },
      update: { title: title.trim(), description: (description || '').trim() },
      create: { slot, title: title.trim(), description: (description || '').trim() },
    });
    res.json({ ok: true, slot: saved.slot, title: saved.title, description: saved.description });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Une erreur est survenue lors de l'enregistrement." });
  }
});

// Filet de sécurité global : si une route plante sans avoir géré l'erreur
// elle-même, on répond proprement plutôt que de laisser planter le process.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Une erreur est survenue.' });
});

// En local (npm run dev / npm start) on démarre un vrai serveur HTTP. Sur
// Vercel, `app` est importé par api/index.js et utilisé comme fonction
// serverless — VERCEL=1 est défini automatiquement par leur plateforme.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`N Vision backend démarré sur http://localhost:${PORT}`);
  });
}

export default app;
