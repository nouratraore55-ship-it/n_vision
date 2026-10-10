// Point d'entrée Vercel : toutes les requêtes (voir vercel.json) sont
// redirigées ici, et Express se charge lui-même du routing interne
// (/api/devis, /api/auth/login, etc.) à partir de req.url.
import app from '../server.js';

export default app;
