# Contexte du projet

Extension Chrome (Manifest V3) personnelle, jamais destinée au Web Store, qui affiche :
1. L'usage de session (5h) et hebdomadaire (7j) sur claude.ai
2. Le % de contexte utilisé dans la conversation en cours (feature absente des outils existants)

## État du repo

Le repo contient l'extension finale. Le sniffer de découverte (Phase 1) n'existe plus en tant
que tel : il ne reste que le nettoyage de ses clés `sniff:` dans `onInstalled`.

Note : le repo public de ClaudeKarma (jrlprost/ClaudeKarma et jrlprost/claudekarma_browser)
est introuvable (404 sur les deux adresses) — pas de code de référence externe disponible.
Tout vient de notre propre découverte réseau.

Deux sources de données, volontairement séparées :

- **Usage (5 h / 7 j)** — sondé toutes les 60 s par le service worker (`chrome.alarms`), écrit
  dans la clé `usage`. L'extraction depuis l'événement SSE `message_limit` a été **abandonnée** :
  trop fragile, et la donnée ne bougeait qu'après l'envoi d'un message.
- **Estimation de contexte** — toujours passive, via le patch `fetch` de `inject.js` (taille du
  GET de conversation + payloads envoyés + texte streamé). Aucun appel réseau émis.

`USAGE_PATH` (`GET /api/organizations/<org>/usage`) et `parseUsage()` dans `usage-source.js`
sont **confirmés** par capture réseau — voir le README pour la forme réelle de la réponse et
le piège d'unité (`utilization`/`percent` en 0-100, pas en fraction 0-1). Testé par
`node test-usage-source.js`.

⚠️ **`ORGS_PATH` reste une supposition** : la requête qui liste les organisations n'a jamais
été capturée — voir la section dédiée du README si le sondage échoue avant même d'atteindre
`.../usage`.

## Contraintes techniques

- Manifest V3 uniquement, JS vanilla, pas de build step (chargeable directement en mode
  développeur via chrome://extensions).
- Toutes les données restent en local (chrome.storage.local) — jamais de serveur tiers. Le seul
  réseau émis par l'extension va vers claude.ai lui-même, pour le sondage d'usage.
- Les endpoints internes de claude.ai ne sont pas garantis stables : le code doit rester
  simple à corriger si un format de réponse change. D'où `usage-source.js`, point d'adaptation
  unique.

---

# Behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
