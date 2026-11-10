# ARMOR LAB

Studio VFX en réalité augmentée, exécuté dans le navigateur avec React, MediaPipe Tasks Vision et Three.js.

## Démarrer

```bash
npm install
npm start
```

Ouvrez l’adresse locale affichée par Vite, puis autorisez l’accès à la caméra. La caméra nécessite `localhost` ou une connexion HTTPS.
Lancez les commandes depuis le dossier `ironman-vfx`.

## Fonctionnalités

- Suivi MediaPipe du visage (478 points), du corps (33 points) et des deux mains (21 points chacune) dans un Web Worker dédié. Les images redimensionnées sont transférées au Worker et les modèles essaient le GPU, puis le CPU.
- Une seule image est inférée à la fois, à 12 FPS maximum et à 384 px maximum sur le grand côté : les frames webcam arrivant pendant une inférence ou entre deux intervalles sont ignorées plutôt que mises en file. Le Worker et l’inférence plafonnée réduisent la concurrence avec le rendu.
- L’armure 3D procédurale couvre le torse, les épaules, les bras, les coudes, les hanches, les jambes, les genoux, la tête et les mains. Les landmarks sont lissés avec une interpolation dépendante du temps pour réduire la latence et les tremblements.
- Matériaux métalliques PBR, environnement de studio généré avec PMREM, réacteur pulsé, 128 nanites instanciés, assemblage séquencé et post-traitement Unreal Bloom avec aberration chromatique subtile et vignettage.
- Le geste « paume ouverte » combine extension et écartement des doigts avec l’orientation apparente de la paume; il déclenche le répulseur et relance l’assemblage nanotech.
- Le rendu WebGL privilégie le GPU, désactive l’antialiasing matériel redondant avec le post-traitement et réduit la résolution du bloom. Les FPS WebGL rendus et la cadence d’inférence Worker sont mesurés séparément : 60 FPS est un objectif, pas une garantie pour tous les appareils ou webcams.
- Contrôles pour afficher les calques, régler l’intensité, mettre en pause, passer en plein écran et exporter une capture.
- Les images de la caméra sont traitées dans le navigateur et ne sont pas envoyées à un serveur.

Au premier démarrage, le navigateur télécharge les fichiers WASM et les modèles MediaPipe. Une connexion Internet est donc requise pour initialiser le suivi. Le flux vidéo reste local au navigateur; aucun backend n’est requis pour la vision.

Le suivi actuel adapte des plaques à des landmarks 2D et n’est pas un système de segmentation/occlusion 3D photoréaliste. Les performances et la fidélité visuelle dépendent de la webcam, du GPU, du navigateur, de l’éclairage et de la distance à la caméra. Un fichier Blender `.blend` n’est pas chargeable directement par Three.js : un modèle exporté en `.glb` serait nécessaire pour remplacer les éléments procéduraux par un asset 3D.

## Vérification

```bash
npm run build
```
