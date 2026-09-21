<script>
  import { onMount, tick } from 'svelte';

  const flows = [
    {
      title: 'Exercices ↔ exobase',
      detail: 'Synchronise le corpus AMSCC dans le sens choisi. Chaque sens est vérifié séparément avant toute écriture.',
      directions: [
        {
          id: 'exercises-to-exobase',
          title: 'Exercices → exobase',
          previewLabel: 'Vérifier',
          applyLabel: 'Vers exobase',
          confirmation: 'Synchroniser les changements AMSCC vérifiés d’Exercices vers exobase ?'
        },
        {
          id: 'exobase-to-exercises',
          title: 'exobase → Exercices',
          previewLabel: 'Vérifier',
          applyLabel: 'Vers Exercices',
          confirmation: 'Remonter les corrections AMSCC vérifiées d’exobase vers Exercices ?\n\nLes fichiers concernés seront ensuite à relire et à committer dans Exercices.'
        }
      ]
    },
    {
      id: 'openyourmath-to-exobase',
      title: 'OpenYourMath → exobase',
      detail: 'Propose les corrections éditoriales détectées dans OpenYourMath.'
    },
    {
      id: 'exobase-to-openyourmath',
      title: 'exobase → OpenYourMath',
      detail: 'Importe le contenu validé et actualise la référence de synchronisation.'
    }
  ];

  const preparations = [
    {
      id: 'metadata',
      title: 'Générer les métadonnées',
      detail: 'Repère les exercices sans résumé, concepts, méthodes, objets ou embedding ; puis les génère avec Ollama ou Albert.',
      previewLabel: 'Analyser les manques',
      applyLabel: 'Générer les métadonnées',
      confirmation: 'Générer les métadonnées manquantes ?\n\nCette action peut utiliser Ollama ou le service Albert et écrit les fichiers content/metadata/.'
    },
    {
      id: 'release',
      title: 'Préparer la release',
      detail: 'Vérifie que la branche main est propre et prête. La publication construit puis envoie l’image Docker ; le serveur reste à mettre à jour séparément.',
      previewLabel: 'Vérifier la release',
      applyLabel: 'Publier l’image',
      danger: true,
      confirmation: 'Publier la release OpenYourMath ?\n\nCette action construit et pousse une image Docker vers GitHub Container Registry. Elle ne déploie pas le serveur.'
    }
  ];

  const snapshots = [
    {
      id: 'publish',
      title: 'Publier la sauvegarde',
      detail: 'Envoie la base SQLite locale, y compris les embeddings non versionnés, vers la release GitHub db-snapshot-dev.',
      actionLabel: 'Publier la sauvegarde',
      confirmation: 'Publier la sauvegarde locale des embeddings ?\n\nLa release GitHub db-snapshot-dev sera créée ou mise à jour. Cette action requiert gh connecté.'
    },
    {
      id: 'update',
      title: 'Récupérer et restaurer',
      detail: 'Télécharge la dernière sauvegarde puis remplace la base locale et reconstruit le cache d’embeddings.',
      actionLabel: 'Mettre à jour cette machine',
      danger: true,
      confirmation: 'Télécharger puis restaurer la sauvegarde des embeddings ?\n\nLa base locale data/exercises.sqlite sera remplacée. Faites d’abord git pull pour aligner les métadonnées versionnées.'
    }
  ];

  let repositories = {};
  let busy = '';
  let previews = {};
  let result = null;
  let error = '';
  let outputElement;
  let activeSource;
  let releaseVersion = null;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Action impossible.');
    return data;
  }

  function remoteLabel(repository) {
    const remote = repository?.remote;
    if (!remote || remote.state === 'no-origin') return 'Aucun dépôt distant';
    if (remote.fetchError) return 'Distant non actualisé';
    if (remote.state === 'no-upstream') return 'Branche sans suivi distant';
    if (remote.state === 'up-to-date') return 'À jour avec le distant';
    if (remote.state === 'ahead') return `${remote.ahead} commit(s) à envoyer`;
    if (remote.state === 'behind') return `${remote.behind} commit(s) à récupérer`;
    if (remote.state === 'diverged') return `${remote.ahead} à envoyer · ${remote.behind} à récupérer`;
    return 'État distant inconnu';
  }

  async function refreshStatus(refreshRemote = false) {
    try {
      repositories = await api(`/api/status${refreshRemote ? '?remote=1' : ''}`);
    } catch (cause) {
      error = cause.message;
    }
  }

  async function refreshReleaseVersion() {
    try {
      releaseVersion = await api('/api/release/version');
    } catch (cause) {
      error = cause.message;
    }
  }

  async function bumpPatchVersion() {
    if (!releaseVersion) return;
    if (!window.confirm(`Passer la version de ${releaseVersion.current} à ${releaseVersion.next} ?\n\nAucun tag ni commit ne sera créé.`)) return;
    busy = 'release:bump';
    error = '';
    try {
      const data = await api('/api/release/bump-patch', { method: 'POST', body: '{}' });
      result = {
        title: 'Numéro de release mis à jour',
        output: `Version ${data.previous} → ${data.current}\n\nRelisez puis committez package.json avant de vérifier la release.`,
        code: 0,
        running: false
      };
      await refreshReleaseVersion();
      await refreshStatus();
    } catch (cause) {
      error = cause.message;
    } finally {
      busy = '';
    }
  }

  async function runSnapshot(snapshot) {
    if (!window.confirm(snapshot.confirmation)) return;
    busy = `snapshot:${snapshot.id}`;
    error = '';
    try {
      const data = await api(`/api/db-snapshot/${snapshot.id}`, { method: 'POST', body: '{}' });
      watchRun(data.runId, `Sauvegarde d’embeddings · ${snapshot.title}`, busy);
    } catch (cause) {
      error = cause.message;
      busy = '';
    }
  }

  async function appendOutput(chunk) {
    result = { ...result, output: `${result.output}${chunk}` };
    await tick();
    outputElement?.scrollTo({ top: outputElement.scrollHeight, behavior: 'smooth' });
  }

  function watchRun(runId, title, busyKey, onComplete = () => {}, isPreview = false) {
    activeSource?.close();
    result = { title, output: 'Démarrage de la commande…\n', code: null, running: true };
    const source = new EventSource(`/api/runs/${runId}/events`);
    activeSource = source;

    source.addEventListener('snapshot', event => {
      const data = JSON.parse(event.data);
      result = { ...result, output: data.output || 'Démarrage de la commande…\n' };
    });
    source.addEventListener('output', event => appendOutput(JSON.parse(event.data).chunk));
    source.addEventListener('complete', event => {
      const data = JSON.parse(event.data);
      source.close();
      if (activeSource === source) activeSource = null;
      const expectedChanges = isPreview && data.canApply && data.code === 1;
      result = { ...result, code: data.code, running: false, expectedChanges };
      busy = '';
      onComplete(data);
      refreshStatus();
    });
    source.onerror = () => {
      if (!result?.running) return;
      source.close();
      if (activeSource === source) activeSource = null;
      result = { ...result, output: `${result.output}\n[La connexion au suivi direct a été interrompue.]\n`, code: 3, running: false };
      busy = '';
    };
  }

  async function preview(flow) {
    busy = `${flow.id}:preview`;
    error = '';
    try {
      const data = await api(`/api/flows/${flow.id}/preview`, { method: 'POST', body: '{}' });
      watchRun(data.runId, `Aperçu · ${flow.title}`, busy, completed => {
        previews = { ...previews, [flow.id]: completed.previewId };
      }, true);
    } catch (cause) {
      error = cause.message;
      busy = '';
    }
  }

  async function apply(flow) {
    const previewId = previews[flow.id];
    if (!previewId) return;
    if (!window.confirm(flow.confirmation || `Appliquer « ${flow.title} » ?\n\nLa sortie de l’aperçu vient d’être vérifiée.`)) return;
    busy = `${flow.id}:apply`;
    error = '';
    try {
      const data = await api(`/api/flows/${flow.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ previewId })
      });
      previews = { ...previews, [flow.id]: null };
      watchRun(data.runId, `Synchronisation · ${flow.title}`, busy);
    } catch (cause) {
      error = cause.message;
      busy = '';
    }
  }

  async function buildContent() {
    if (!window.confirm('Reconstruire le contenu d’OpenYourMath ?')) return;
    busy = 'build';
    error = '';
    try {
      const data = await api('/api/build-content', { method: 'POST', body: '{}' });
      watchRun(data.runId, 'Reconstruction du contenu OpenYourMath', busy);
    } catch (cause) {
      error = cause.message;
      busy = '';
    }
  }

  onMount(() => {
    refreshStatus(true);
    refreshReleaseVersion();
  });
</script>

<svelte:head>
  <meta name="description" content="Tableau de bord local des synchronisations Automath." />
</svelte:head>

<main>
  <header>
    <p class="eyebrow">Automath · local uniquement</p>
    <div class="heading">
      <div>
        <h1>Synchronisations</h1>
        <p>Vérifiez d’abord, appliquez ensuite, puis relisez le diff Git.</p>
      </div>
      <button class="secondary" onclick={() => refreshStatus(true)} disabled={busy}>Actualiser les dépôts</button>
    </div>
  </header>

  <section class="repositories" aria-label="État des dépôts">
    {#each [
      ['exercises', 'Exercices'],
      ['exobase', 'exobase'],
      ['openyourmath', 'OpenYourMath']
    ] as [key, label]}
      {@const repository = repositories[key]}
      <article class:dirty={repository && !repository.clean} class="repository">
        <span>{label}</span>
        {#if repository}
          <strong>{repository.clean ? 'Propre' : `${repository.changes} modification(s)`}</strong>
          <small>commit {repository.commit}</small>
          <small class:remote-warning={repository.remote?.state !== 'up-to-date'} class="remote-status">{remoteLabel(repository)}</small>
          {#if !repository.clean && repository.status}
            <details>
              <summary>Voir les fichiers concernés</summary>
              <pre class="status-output">{repository.status}</pre>
            </details>
          {/if}
        {:else}
          <strong>Lecture…</strong>
        {/if}
      </article>
    {/each}
  </section>

  <section class="flows" aria-label="Flux de synchronisation">
    {#each flows as flow}
      <article class="flow-card">
        <h2>{flow.title}</h2>
        <p>{flow.detail}</p>
        {#if flow.directions}
          <div class="direction-list">
            {#each flow.directions as direction}
              {@const hasPreview = Boolean(previews[direction.id])}
              <div class="direction-control">
                <strong>{direction.title}</strong>
                <div class="actions">
                  <button onclick={() => preview(direction)} disabled={Boolean(busy)}>
                    {busy === `${direction.id}:preview` ? 'Vérification…' : direction.previewLabel}
                  </button>
                  <button class="apply" onclick={() => apply(direction)} disabled={Boolean(busy) || !hasPreview}>
                    {busy === `${direction.id}:apply` ? 'Synchronisation…' : direction.applyLabel}
                  </button>
                </div>
                <small>{hasPreview ? 'Aperçu disponible pendant 10 minutes.' : 'Un aperçu est requis.'}</small>
              </div>
            {/each}
          </div>
        {:else}
          {@const hasPreview = Boolean(previews[flow.id])}
          <div class="actions">
            <button onclick={() => preview(flow)} disabled={Boolean(busy)}>
              {busy === `${flow.id}:preview` ? 'Vérification…' : (flow.previewLabel || 'Vérifier')}
            </button>
            <button class="apply" onclick={() => apply(flow)} disabled={Boolean(busy) || !hasPreview}>
              {busy === `${flow.id}:apply` ? 'Application…' : (flow.applyLabel || 'Appliquer')}
            </button>
          </div>
          <small>{hasPreview ? 'Aperçu récent disponible pendant 10 minutes.' : 'Un aperçu récent est requis.'}</small>
        {/if}
      </article>
    {/each}
  </section>

  <section class="preparation" aria-label="Préparer la publication">
    <div class="section-heading">
      <p class="eyebrow">Avant publication</p>
      <h2>Compléter et publier le contenu</h2>
    </div>
    <div class="preparation-cards">
      <article class="preparation-card">
        <h3>1 · Reconstruire le contenu</h3>
        <p>Met à jour le cache LaTeX, la base locale et les fiches après toute modification de source. Cette étape ne génère pas les métadonnées sémantiques.</p>
        <div class="actions">
          <button onclick={buildContent} disabled={Boolean(busy)}>
            {busy === 'build' ? 'Reconstruction…' : 'Reconstruire le contenu'}
          </button>
        </div>
        <small>À lancer après une synchronisation qui modifie des fichiers .tex.</small>
      </article>
      {#each preparations as flow}
        {@const hasPreview = Boolean(previews[flow.id])}
        <article class:danger={flow.danger} class="preparation-card">
          <h3>{flow.id === 'metadata' ? '2 · ' : '3 · '}{flow.title}</h3>
          <p>{flow.detail}</p>
          {#if flow.id === 'release' && releaseVersion}
            <div class="release-version">
              <span>Version actuelle : <strong>{releaseVersion.current}</strong></span>
              <button class="secondary compact" onclick={bumpPatchVersion} disabled={Boolean(busy)}>
                {busy === 'release:bump' ? 'Mise à jour…' : `Passer à ${releaseVersion.next}`}
              </button>
            </div>
          {/if}
          <div class="actions">
            <button onclick={() => preview(flow)} disabled={Boolean(busy)}>
              {busy === `${flow.id}:preview` ? 'Analyse…' : flow.previewLabel}
            </button>
            <button class:danger={flow.danger} class="apply" onclick={() => apply(flow)} disabled={Boolean(busy) || !hasPreview}>
              {busy === `${flow.id}:apply` ? 'Action en cours…' : flow.applyLabel}
            </button>
          </div>
          <small>{hasPreview ? 'Aperçu récent disponible pendant 10 minutes.' : 'Un aperçu récent est requis.'}</small>
        </article>
      {/each}
    </div>
  </section>

  <section class="snapshots" aria-label="Transfert des embeddings">
    <div class="section-heading">
      <p class="eyebrow">Embeddings</p>
      <h2>Transférer la base locale entre machines</h2>
    </div>
    <div class="snapshot-cards">
      {#each snapshots as snapshot}
        <article class:danger={snapshot.danger} class="snapshot-card">
          <h3>{snapshot.title}</h3>
          <p>{snapshot.detail}</p>
          <div class="actions">
            <button class:danger={snapshot.danger} class="apply" onclick={() => runSnapshot(snapshot)} disabled={Boolean(busy)}>
              {busy === `snapshot:${snapshot.id}` ? 'Action en cours…' : snapshot.actionLabel}
            </button>
          </div>
          <small>{snapshot.id === 'publish' ? 'Les métadonnées textuelles restent à committer séparément.' : 'La sauvegarde ne remplace pas git pull pour les métadonnées.'}</small>
        </article>
      {/each}
    </div>
  </section>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if result}
    <section class="result" aria-live="polite">
      <div class="result-heading">
        <h2>{result.title}</h2>
        {#if result.running}
          <span class="code running">en cours</span>
        {:else if result.expectedChanges}
          <span class="code changes">changements détectés</span>
        {:else}
          <span class:failure={result.code !== 0} class="code">code {result.code}</span>
        {/if}
      </div>
      <pre bind:this={outputElement}>{result.output}</pre>
    </section>
  {/if}

  <footer>Les commits et le déploiement du serveur restent des étapes volontaires, réalisées hors de cette interface.</footer>
</main>
