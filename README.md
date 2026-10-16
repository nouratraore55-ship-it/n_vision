# N Vision — Backend

Reçoit les demandes de devis (avec logo/designs/photos joints), les stocke dans une vraie base de données, gère les comptes admin, et peut notifier par email.

## Installation (une seule fois)

```
npm install
```

Copie `.env.example` en `.env` et remplis au minimum `JWT_SECRET` (une longue phrase aléatoire, juste pour toi).

Crée la base de données :

```
npm run migrate
```

Crée ton compte admin (ça te demande l'email et le mot de passe que tu veux utiliser pour te connecter à `/admin`) :

```
npm run create-admin
```

Tu pourras relancer cette commande plus tard pour créer un compte pour quelqu'un d'autre de ton équipe.

## Lancer le serveur

```
npm start
```

Le serveur tourne sur `http://localhost:4000`. Laisse-le ouvert dans un terminal pendant que tu utilises le site (`npm run dev` dans le dossier `site`, dans un autre terminal).

## Fonctionnalités

- **Base de données** : Prisma + SQLite (un vrai fichier de base de données, créé automatiquement par `npm run migrate` — rien à installer à côté).
- **Demandes de devis** : le questionnaire du site envoie les réponses ici, avec les fichiers joints (logo, designs, photos produit).
- **Fichiers** : stockés dans `uploads/`, jamais accessibles publiquement — seulement en te connectant à `/admin`.
- **Photos du site** : depuis `/admin`, tu peux envoyer une vraie photo pour remplacer un visuel du site (pour l'instant : la photo du hero sur la page d'accueil). Contrairement aux fichiers des devis, ces photos sont publiques puisqu'elles s'affichent directement sur le site.
- **Comptes admin** : connexion par email + mot de passe (chiffré). Chaque compte a son propre accès.
- **Sécurité** : mots de passe chiffrés, sessions limitées à 12h, protection anti-abus sur le formulaire public et la connexion, en-têtes de sécurité HTTP.
- **Notifications email** (optionnel) : si tu remplis les champs `SMTP_...` et `NOTIFY_EMAIL` dans `.env`, tu reçois un email à chaque nouvelle demande. Sinon, cette fonctionnalité reste simplement désactivée, rien ne casse.

## Mise à jour du 19/09 : photos du site

Cette mise à jour ajoute la gestion des photos depuis l'admin. Elle change la base de données (nouvelle table), donc il faut relancer une migration une seule fois, dans le dossier `backend` :

```
npm run migrate
```

Cette commande met à jour ta base de données automatiquement (pas besoin de répondre à quoi que ce soit). Ensuite, relance simplement `npm start` comme d'habitude.

## Mise à jour d'octobre : nouveau design

- **Réalisations** : liste libre gérée depuis l'admin (ajouter, modifier, supprimer), avec titre, lieu, description et photo. Routes : `GET /api/realisations`, `POST /api/realisations`, `PUT /api/realisations/:id`, `DELETE /api/realisations/:id`. La photo d'une réalisation s'envoie via `POST /api/site-images/<id>`.
- **Photos du site** : emplacements `accueil-hero` (photo ou vidéo), `accueil-valeurs`, `svc-packaging`, `svc-sacs`, `svc-papier`, `svc-cartes`. Sans fichier, le site affiche son visuel par défaut (logo animé, dessins).
- Aucun changement de base de données : rien à migrer.

## Mis en pause pour l'instant

- Génération et envoi du devis chiffré au client directement depuis l'admin (on le fera dans un second temps).

## Si `npm install` ou `npm run migrate` bloque

Ces commandes téléchargent un petit programme (le moteur de Prisma) la première fois. Si ça affiche une erreur de téléchargement, vérifie ta connexion internet et réessaie — et dis-le-moi si ça persiste, je regarde avec toi.

## Prochaine étape (au moment de mettre le site en ligne)

Ce serveur devra être hébergé quelque part (ex : Render, Railway) pour être accessible en dehors de ton PC, avec une vraie base de données hébergée (on pourra garder SQLite ou passer sur PostgreSQL selon l'hébergeur). On s'en occupera au moment du déploiement.
