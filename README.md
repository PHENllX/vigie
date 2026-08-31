# Vigie

Application Windows pour surveiller ses caméras Wyze depuis deux PC, sans passer par
le dashboard officiel.

Vigie, comme le poste de guet en haut du mât : l'app qui garde un œil sur la maison.

## Architecture

Un seul PC est **l'hôte** : il se connecte aux caméras via
[docker-wyze-bridge](https://github.com/mrlt8/docker-wyze-bridge) (un container Docker),
sert le dashboard sur le réseau local et enregistre les clips. L'autre PC est un
**client** : il se connecte simplement au dashboard de l'hôte.

Cette séparation n'est pas un détail : les caméras Wyze n'acceptent qu'un petit nombre
de connexions simultanées. Deux hôtes = flux instables.

```
   Caméras Wyze
        │
        ▼
  ┌─────────────────────────┐        ┌──────────────────┐
  │  PC HÔTE                │        │  PC SECONDAIRE   │
  │  ├ Docker: wyze-bridge  │◄───────┤  Dashboard       │
  │  ├ Serveur dashboard    │  LAN   │  + notifications │
  │  └ Enregistrements      │        └──────────────────┘
  └─────────────────────────┘
```

## Construire l'installateur

Double-clique `build.bat` (nécessite [Node.js](https://nodejs.org) LTS). L'installateur
sort dans `dist\Vigie Setup 1.0.0.exe`.

En ligne de commande :

```bash
npm install
npm start          # lance l'app en dev
npm run dist       # produit l'installateur Windows dans dist/
```

## Installation

1. Lance `Vigie Setup 1.0.0.exe` sur les deux PC.
2. Sur le PC hôte : choisis « PC hôte », entre tes identifiants Wyze + la clé API,
   note l'adresse IP affichée.
3. Sur l'autre PC : choisis « PC secondaire », entre cette adresse IP.

Docker Desktop n'est requis que sur le PC hôte.

## Où sont les données

Tout est dans `C:\Users\<toi>\Vigie\` :

- `config.json` — le rôle du PC et les identifiants
- `docker-compose.yml` / `.env` — générés par l'app, modifiables si tu veux ajuster
- `recordings/` — les clips, un dossier par caméra

## Mises à jour automatiques

Vigie vérifie les Releases du dépôt `PHENllX/vigie` au démarrage puis toutes les
6 heures. Quand une version est disponible, l'application propose de la télécharger,
puis d'installer — rien ne se télécharge sans accord. Le menu de la barre système
offre aussi « Vérifier les mises à jour… » pour forcer un contrôle.

### Publier une nouvelle version

Une seule fois, crée le jeton GitHub :

1. https://github.com/settings/tokens → « Generate new token (classic) »
2. Coche uniquement la portée **repo**
3. `setx GH_TOKEN ton_jeton` puis ouvre une nouvelle fenêtre de commandes

Ensuite, à chaque version : double-clique **`release.bat`**. Il incrémente la version,
construit l'installateur et publie la Release. Les deux PC la proposeront tout seuls.

Le dépôt doit être **public** — c'est ce qui permet aux applications installées de
télécharger la mise à jour sans jeton embarqué. Aucun secret ne s'y trouve : les
identifiants Wyze vivent dans `config.json`, sur chaque PC.

## Structure du code

- `main.js` — processus principal Electron : config, gestion Docker, tray, notifications
- `preload.js` — pont sécurisé vers les pages
- `ui/setup.html` — assistant de configuration
- `server/dashboard.js` — serveur Express + WebSocket (tourne sur l'hôte)
- `server/public/index.html` — le dashboard

## Notes

- Le webhook de mouvement du bridge pointe vers `host.docker.internal:3001`, reçu par
  le serveur Express, qui diffuse ensuite l'évènement en WebSocket à tous les
  dashboards connectés.
- Vigie se lance au démarrage de Windows (réduite dans la barre système sur l'hôte).
- Fermer la fenêtre réduit dans la barre système — l'enregistrement continue.
- `WB_AUTH=false` : conçu pour un réseau local de confiance. Pour y accéder de
  l'extérieur, passe par un VPN (Tailscale, WireGuard), n'expose pas les ports
  directement sur Internet.

---

Développé par [NStudio](https://nstudio.ca)
