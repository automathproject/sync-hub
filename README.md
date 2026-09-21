# Automath Sync Hub

Tableau de bord **local** des synchronisations entre `Exercices`, `exobase` et
`openyourmath-v2`. Il appelle les scripts officiels existants : aucune logique
de copie n'est dupliquée ici.

## Lancer en développement

```bash
pnpm install
pnpm dev
```

Ouvrir ensuite <http://127.0.0.1:5174>. Le serveur d'actions écoute uniquement
sur `127.0.0.1:4317` ; il n'est jamais exposé sur le réseau.

Pour un lancement sans serveur de développement :

```bash
pnpm build
pnpm start
```

Puis ouvrir <http://127.0.0.1:4317>.

## Principes de sécurité

- l'interface ne peut lancer que neuf actions connues : les quatre
  synchronisations entre dépôts, la reconstruction du contenu, l'indexation
  des métadonnées, la publication de release et le transfert de la sauvegarde
  locale des embeddings ;
- un dépôt non propre affiche le détail compact de son `git status` ;
- l'actualisation des dépôts consulte `origin` et indique les commits à envoyer
  ou à récupérer ;
- chaque synchronisation exige un aperçu de moins de dix minutes avant son
  application ;
- aucune commande arbitraire, aucun commit et aucun déploiement ne sont
  disponibles ;
- la sortie des scripts apparaît en direct, puis reste visible afin de relire
  les fichiers concernés et les conflits.

La carte de métadonnées commence par une analyse sans écriture. Sa génération
utilise Ollama ou Albert et crée les fichiers versionnés sous
`content/metadata/`. La carte release contrôle d'abord que le dépôt est propre
sur `main`, puis la publication construit et pousse l'image Docker ; le
déploiement du serveur demeure manuel.

La carte release peut aussi incrémenter le numéro de patch (`x.y.z` vers
`x.y.z+1`) dans `package.json`. Cette opération exige également un dépôt propre
sur `main`, et ne crée ni commit ni tag.

## Chemins locaux

Par défaut, les dépôts sont attendus comme répertoires frères :

```text
Automath/
├── Exercices/
├── exobase/
├── openyourmath-v2/
└── sync-hub/
```

Pour utiliser d'autres emplacements, copier
`.sync-hub.local.example.json` vers `.sync-hub.local.json` puis ajuster les
chemins. Ils sont relatifs au dossier `sync-hub`, mais peuvent aussi être
absolus. Ce fichier reste local et est ignoré par Git. Sync Hub transmet ces
emplacements aux scripts de synchronisation : les trois dépôts n'ont donc pas
besoin d'être voisins.

Le guide versionné [CONFIGURATION-LOCALE.md](CONFIGURATION-LOCALE.md) contient
un modèle prêt à transmettre à une IA pour configurer une autre machine.
