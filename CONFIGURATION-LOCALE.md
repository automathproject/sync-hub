# Configuration de Sync Hub sur une autre machine

Ce guide est versionné avec Sync Hub. Il sert à installer l'interface sur une
machine où `Exercices`, `exobase` et `openyourmath-v2` ne sont pas forcément
placés dans des dossiers voisins.

## Ce qui doit être présent

La machine doit disposer de trois clones Git utilisables :

- `Exercices` ;
- `exobase` ;
- `openyourmath-v2`.

Installer aussi Sync Hub depuis son dépôt, puis ses dépendances. Les
dépendances d'OpenYourMath doivent être installées car certaines actions de
synchronisation et de préparation y sont lancées.

## Le seul fichier à adapter

Dans le dossier de Sync Hub, créer le fichier **local** suivant :

`.sync-hub.local.json`

Il n'est pas versionné et ne doit jamais être committé. Il indique uniquement
où se trouvent les trois clones sur cette machine.

Utiliser de préférence des chemins absolus :

```json
{
  "exercises": "/chemin/absolu/vers/Exercices",
  "exobase": "/chemin/absolu/vers/exobase",
  "openyourmath": "/chemin/absolu/vers/openyourmath-v2"
}
```

Les chemins relatifs sont également acceptés ; ils sont toujours interprétés
depuis le dossier contenant Sync Hub. Exemple :

```json
{
  "exercises": "../depots/Exercices",
  "exobase": "../depots-partages/exobase",
  "openyourmath": "../plateforme/openyourmath-v2"
}
```

Sync Hub transmet automatiquement ces deux informations aux scripts :

- le chemin d'`Exercices` aux synchronisations AMSCC entre Exercices et
  exobase ;
- le chemin d'exobase aux synchronisations entre exobase et OpenYourMath.

Il n'est donc pas nécessaire de modifier les scripts des trois dépôts.

## Demander la configuration à une IA

Fournir à l'IA ce document et les trois chemins réels, puis lui demander :

> Crée dans le dossier Sync Hub le fichier local `.sync-hub.local.json`.
> Utilise exactement les trois chemins ci-dessous. Ne modifie aucun script, ne
> crée aucun commit et n'ajoute pas ce fichier à Git.

L'IA doit produire uniquement ce fichier :

```json
{
  "exercises": "CHEMIN_EXERCICES",
  "exobase": "CHEMIN_EXOBASE",
  "openyourmath": "CHEMIN_OPENYOURMATH"
}
```

## Vérification

Lancer Sync Hub puis ouvrir l'interface locale. Les trois cartes d'état des
dépôts doivent afficher un commit, sans message « Dépôt introuvable ». Faire un
aperçu de synchronisation avant toute application : aucune copie ne doit être
faite pendant un aperçu.

Si un dépôt a été déplacé, modifier uniquement `.sync-hub.local.json`, puis
redémarrer Sync Hub.
