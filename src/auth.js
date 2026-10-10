import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '12h';

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    // En production, pas de filet de sécurité : sans vrai secret, n'importe qui
    // pourrait fabriquer un token admin valide. On arrête le serveur plutôt que
    // de démarrer avec une clé connue de tous.
    console.error(
      '❌ JWT_SECRET manquant en production — arrêt du serveur. Ajoute une valeur longue et aléatoire dans les variables d\'environnement.'
    );
    process.exit(1);
  }
  console.warn(
    '⚠️  JWT_SECRET manquant dans .env — utilisation d\'une clé de développement non sécurisée. Ajoute une valeur longue et aléatoire avant de déployer.'
  );
}

export function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET || 'dev-only-insecure-secret', {
    expiresIn: TOKEN_TTL,
  });
}

export function requireAuth(req, res, next) {
  const header = req.header('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Connexion requise.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET || 'dev-only-insecure-secret');
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée, reconnecte-toi.' });
  }
}
