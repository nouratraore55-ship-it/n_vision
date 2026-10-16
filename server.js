import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';

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
  // Fond du hero (photo ou courte vidéo). Sans fichier : logo animé.
  'home-hero',
  // Photo de la section « Un emballage qui vous ressemble ». Sans fichier : case vide.
  'home-valeurs',
  // Les 4 cartes "Nos services" de l'accueil. Sans fichier : dessin.
  'service-packaging',
  'service-sacs',
  'service-papier-de-soie',
  'service-cartes',
]);

// Les photos des réalisations utilisent le même système, avec pour
// emplacement l'identifiant de la réalisation (ex: "real-lq3x9k2a").
async function isAllowedSlot(slot) {
  if (SITE_IMAGE_SLOTS.has(slot)) return true;
  const r = await prisma.realisation.findUnique({ where: { slot } });
  return Boolean(r);
}

// Envoi/remplacement d'une photo (admin uniquement)
app.post('/api/site-images/:slot', requireAuth, (req, res, next) => {
  // On vérifie l'emplacement AVANT de laisser multer traiter le fichier, pour
  // ne jamais envoyer un fichier orphelin vers R2 pour un slot inconnu.
  isAllowedSlot(req.params.slot)
    .then((ok) => (ok ? next() : res.status(400).json({ error: 'Emplacement photo inconnu.' })))
    .catch(next);
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

// Supprime la photo d'un emplacement (admin uniquement) : le site retombera
// sur son visuel par défaut tant qu'une nouvelle photo n'est pas envoyée.
app.delete('/api/site-images/:slot', requireAuth, async (req, res) => {
  const { slot } = req.params;
  try {
    if (!(await isAllowedSlot(slot))) {
      return res.status(400).json({ error: 'Emplacement photo inconnu.' });
    }
    const existing = await prisma.siteImage.findUnique({ where: { slot } });
    if (!existing) {
      return res.status(404).json({ error: "Il n'y a pas de photo à cet emplacement." });
    }
    await deleteFromR2(existing.filename);
    await prisma.siteImage.delete({ where: { slot } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'La suppression a échoué.' });
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
// RÉALISATIONS — liste libre gérée depuis l'admin (ajout, modification,
// suppression). Chaque réalisation a un titre, un lieu, une description et
// une photo (stockée via SiteImage, avec pour emplacement son identifiant).
//
// Pas de changement de base de données : on réutilise la table Realisation.
//  - slot        = identifiant ("real-<horodatage>"), sert aussi à trier
//  - title       = titre
//  - description = texte JSON { text, lieu } (une ancienne description en
//                  texte simple est relue telle quelle)
// ---------------------------------------------------------------------------

function parseRealisation(row, imageSlots) {
  let text = row.description || '';
  let lieu = '';
  try {
    const d = JSON.parse(row.description);
    if (d && typeof d === 'object') {
      text = d.text || '';
      lieu = d.lieu || '';
    }
  } catch {
    // ancienne description en texte simple
  }
  return {
    id: row.slot,
    title: row.title,
    lieu,
    description: text,
    hasImage: imageSlots.has(row.slot),
    updatedAt: row.updatedAt,
  };
}

function packDescription(body) {
  return JSON.stringify({
    text: String(body.description || '').trim(),
    lieu: String(body.lieu || '').trim(),
  });
}

function newRealisationId() {
  // horodatage en base 36 : les identifiants se trient dans l'ordre de création
  return `real-${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
}

// Liste complète (public — utilisée sur le site)
app.get('/api/realisations', async (req, res) => {
  try {
    const rows = await prisma.realisation.findMany({ orderBy: { slot: 'asc' } });
    const images = await prisma.siteImage.findMany({
      where: { slot: { in: rows.map((r) => r.slot) } },
      select: { slot: true },
    });
    const imageSlots = new Set(images.map((i) => i.slot));
    res.json(rows.map((r) => parseRealisation(r, imageSlots)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Une erreur est survenue.' });
  }
});

// Ajout d'une réalisation (admin uniquement) — la photo s'envoie ensuite
// via POST /api/site-images/<id>
app.post('/api/realisations', requireAuth, async (req, res) => {
  const { title } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Le titre est requis.' });
  }
  try {
    const row = await prisma.realisation.create({
      data: { slot: newRealisationId(), title: String(title).trim(), description: packDescription(req.body) },
    });
    res.status(201).json(parseRealisation(row, new Set()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Une erreur est survenue lors de l'enregistrement." });
  }
});

// Modification (admin uniquement)
app.put('/api/realisations/:id', requireAuth, async (req, res) => {
  const { title } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Le titre est requis.' });
  }
  try {
    const existing = await prisma.realisation.findUnique({ where: { slot: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Réalisation introuvable.' });
    const row = await prisma.realisation.update({
      where: { slot: req.params.id },
      data: { title: String(title).trim(), description: packDescription(req.body) },
    });
    const img = await prisma.siteImage.findUnique({ where: { slot: row.slot } });
    res.json(parseRealisation(row, new Set(img ? [row.slot] : [])));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Une erreur est survenue lors de l'enregistrement." });
  }
});

// Suppression, avec sa photo (admin uniquement)
app.delete('/api/realisations/:id', requireAuth, async (req, res) => {
  try {
    const existing = await prisma.realisation.findUnique({ where: { slot: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Réalisation introuvable.' });
    const img = await prisma.siteImage.findUnique({ where: { slot: existing.slot } });
    if (img) {
      await deleteFromR2(img.filename);
      await prisma.siteImage.delete({ where: { slot: existing.slot } });
    }
    await prisma.realisation.delete({ where: { slot: existing.slot } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'La suppression a échoué.' });
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
